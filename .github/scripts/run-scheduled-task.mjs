// Runs one or more Base44 backend functions as a logged-in user.
//
// Base44 apps set to "private" visibility reject every request at the
// platform gateway unless the caller has a real session — there is no
// server-to-server API key. So instead of faking auth, this script logs in
// exactly like a browser would (email + password) using the official SDK,
// then invokes the given functions in order. This is what stands in for
// Base44's missing built-in cron/scheduler.
//
// sync-batch / score-batch: pass shared runStartedAt, loop while remaining > 0
// backtest-strategies: full rebuild (weekly cron only)
// detect-consensus / run-paper-trades: single shot per run
//
// Required env vars: BASE44_APP_ID, BASE44_BOT_EMAIL, BASE44_BOT_PASSWORD
// Usage: node run-scheduled-task.mjs <function-name> [<function-name> ...]

import { createClient } from "@base44/sdk";

const appId = process.env.BASE44_APP_ID;
const email = process.env.BASE44_BOT_EMAIL;
const password = process.env.BASE44_BOT_PASSWORD;
const functionNames = process.argv.slice(2);

const DELAY_BETWEEN_CALLS_MS = 5000;
const RATE_LIMIT_RETRY_MS = 90000;

// Cap work per cron tick so a */30 schedule finishes in ~5–8 min instead of
// trying to sync all ~350 wallets in one 17-minute marathon.
const STEP_LIMITS = {
  "sync-batch": 6,
  "score-batch": 3,
  "backtest-strategies": 50,
};
const DEFAULT_STEP_LIMIT = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(err) {
  return JSON.stringify(err?.response?.data || err?.data || err?.message || err || "");
}

function isRateLimit(err) {
  return /rate limit|traffic volume limit/i.test(errorText(err));
}

function isOptionalStep(name) {
  return name === "run-paper-trades";
}

function handleOptionalLimit(name) {
  warnings.push(`${name} skipped after API limit (sync & alerts still ran)`);
  console.warn(`${name} still limited — continuing without failing the job`);
}

if (!appId || !email || !password) {
  console.error("Missing BASE44_APP_ID, BASE44_BOT_EMAIL, or BASE44_BOT_PASSWORD");
  process.exit(1);
}
if (!functionNames.length) {
  console.error("Usage: node run-scheduled-task.mjs <function-name> [<function-name> ...]");
  process.exit(1);
}

const base44 = createClient({ appId });

let hadError = false;
const warnings = [];

try {
  await base44.auth.loginViaEmailPassword(email, password);
  console.log("Logged in successfully.");
} catch (err) {
  console.error("Login failed:", err?.message || err);
  process.exit(1);
}

async function invokeOnce(name, payload) {
  const res = await base44.functions.invoke(name, payload);
  console.log(`${name} ->`, JSON.stringify(res.data));
  if (res.data?.error) {
    const err = new Error(res.data.error);
    err.response = { data: res.data };
    throw err;
  }
  return res;
}

async function invokeWithRetry(name, payload) {
  try {
    return await invokeOnce(name, payload);
  } catch (err) {
    if (!isRateLimit(err)) {
      throw err;
    }

    console.warn(`${name}: API limit — retrying once in ${RATE_LIMIT_RETRY_MS / 1000}s...`);
    await sleep(RATE_LIMIT_RETRY_MS);

    try {
      return await invokeOnce(name, payload);
    } catch (retryErr) {
      if (isRateLimit(retryErr) && isOptionalStep(name)) {
        handleOptionalLimit(name);
        return null;
      }
      throw retryErr;
    }
  }
}

for (const name of functionNames) {
  const runStartedAt = new Date().toISOString();
  const stepLimit = STEP_LIMITS[name] ?? DEFAULT_STEP_LIMIT;
  let iteration = 0;
  let stepFailed = false;

  while (iteration < stepLimit) {
    iteration += 1;
    try {
      console.log(`Invoking ${name} (call ${iteration})...`);

      let payload = {};
      if (name === "sync-batch" || name === "score-batch") {
        payload = { runStartedAt };
      } else if (name === "detect-consensus") {
        payload = { minWallets: 2 };
      } else if (name === "backtest-strategies") {
        payload = { force: true };
      }

      const res = await invokeWithRetry(name, payload);
      if (!res) {
        break;
      }

      if (name === "backtest-strategies") {
        break;
      } else if (name === "sync-batch" || name === "score-batch") {
        const remaining = res.data?.remaining;
        if (!remaining || remaining <= 0) break;
      } else {
        break;
      }

      await sleep(DELAY_BETWEEN_CALLS_MS);
    } catch (err) {
      if (isRateLimit(err) && isOptionalStep(name)) {
        handleOptionalLimit(name);
        break;
      }

      if (isRateLimit(err) && (name === "sync-batch" || name === "score-batch") && iteration > 1) {
        warnings.push(`${name} stopped early after API limit — partial progress saved for next run`);
        console.warn(warnings[warnings.length - 1]);
        stepFailed = true;
        break;
      }

      stepFailed = true;
      hadError = name === "sync-batch" || name === "score-batch";
      console.error(`${name} failed:`, err?.response?.data || err?.message || err);
      break;
    }
  }

  if (iteration >= stepLimit) {
    warnings.push(`${name} hit per-run cap (${stepLimit} calls) — will continue next run`);
    console.warn(warnings[warnings.length - 1]);
  }

  // Don't hammer the API if sync/score didn't finish — wait for next cron
  if (stepFailed && (name === "sync-batch" || name === "score-batch")) {
    console.warn(`Stopping early — ${name} failed, skipping remaining steps this run`);
    break;
  }
}

base44.cleanup();

if (warnings.length) {
  console.log("Warnings:", warnings.join("; "));
}

process.exit(hadError ? 1 : 0);
