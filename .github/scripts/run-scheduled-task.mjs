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
// backtest-strategies: paginate with offset until remaining presets = 0
// detect-consensus / run-paper-trades: single shot per run
//
// Required env vars: BASE44_APP_ID, BASE44_BOT_EMAIL, BASE44_BOT_PASSWORD
// Usage: node run-scheduled-task.mjs <function-name> [<function-name> ...]

import { createClient } from "@base44/sdk";

const appId = process.env.BASE44_APP_ID;
const email = process.env.BASE44_BOT_EMAIL;
const password = process.env.BASE44_BOT_PASSWORD;
const functionNames = process.argv.slice(2);

const MAX_ITERATIONS = 40;
const DELAY_BETWEEN_CALLS_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

try {
  await base44.auth.loginViaEmailPassword(email, password);
  console.log("Logged in successfully.");
} catch (err) {
  console.error("Login failed:", err?.message || err);
  process.exit(1);
}

for (const name of functionNames) {
  const runStartedAt = new Date().toISOString();
  let iteration = 0;
  let offset = 0;

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

      const res = await base44.functions.invoke(name, payload);
      console.log(`${name} ->`, JSON.stringify(res.data));

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
      hadError = true;
      console.error(`${name} failed:`, err?.response?.data || err?.message || err);
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    console.error(`${name} still had work left after ${MAX_ITERATIONS} calls — will continue next run.`);
  }
}

base44.cleanup();
process.exit(hadError ? 1 : 0);
