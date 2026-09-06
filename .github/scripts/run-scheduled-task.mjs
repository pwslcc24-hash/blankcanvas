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

const MAX_ITERATIONS = 50;
const DELAY_BETWEEN_CALLS_MS = 5000;
const RATE_LIMIT_RETRY_MS = 90000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(err) {
  const msg = JSON.stringify(err?.response?.data || err?.message || err || "");
  return /rate limit|traffic volume limit/i.test(msg);
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
  return res;
}

for (const name of functionNames) {
  const runStartedAt = new Date().toISOString();
  let iteration = 0;
  let stepFailed = false;

  while (iteration < MAX_ITERATIONS) {
    iteration += 1;
    try {
      console.log(`Invoking ${name} (call ${iteration})...`);

      let payload = {};
      if (name === "sync-batch" || name === "score-batch") {
        payload = { runStartedAt };
      } else if (name === "backtest-strategies") {
        payload = { force: true };
      }

      const res = await invokeOnce(name, payload);

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
      if (isRateLimit(err)) {
        console.warn(`${name}: API limit — retrying once in ${RATE_LIMIT_RETRY_MS / 1000}s...`);
        await sleep(RATE_LIMIT_RETRY_MS);
        try {
          let payload = {};
          if (name === "sync-batch" || name === "score-batch") {
            payload = { runStartedAt };
          }
          await invokeOnce(name, payload);
          break;
        } catch (retryErr) {
          if (isRateLimit(retryErr) && name === "run-paper-trades") {
            warnings.push(`${name} skipped after API limit (sync & alerts still ran)`);
            console.warn(`${name} still limited — continuing without failing the job`);
            break;
          }
          stepFailed = true;
          hadError = name === "sync-batch" || name === "score-batch";
          console.error(`${name} failed on retry:`, retryErr?.response?.data || retryErr?.message || retryErr);
          break;
        }
      } else {
        stepFailed = true;
        hadError = true;
        console.error(`${name} failed:`, err?.response?.data || err?.message || err);
        break;
      }
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    warnings.push(`${name} still had work after ${MAX_ITERATIONS} calls — will continue next run`);
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
