// Quick smoke test for Strategy Lab data + get-trade-participants
const strategies = await base44.entities.PaperStrategy.list("-roi", 50);
const strict = strategies.find((s) => s.name?.includes("Strict: 5 wallets"));
if (!strict) {
  console.log("FAIL: Strict: 5 wallets strategy not found");
  process.exit(1);
}

console.log("Strategy:", strict.name);
console.log("  past resolved:", strict.resolved_trades, "roi:", strict.roi, "open:", strict.open_trades);

const trades = await base44.entities.PaperTrade.filter(
  { strategy_id: strict.strategy_id },
  "-entry_at",
  10
);
console.log("  loaded trades:", trades.length);

const liveFinished = trades.filter((t) => !t.is_backtest && (t.status === "won" || t.status === "lost"));
const sample = liveFinished[0] || trades.find((t) => t.status === "won" || t.status === "lost");
if (!sample) {
  console.log("WARN: no finished trade to test wallet lookup");
  process.exit(0);
}

console.log("Sample trade:", sample.market_title?.slice(0, 50));
console.log("  wallet_count:", sample.wallet_count, "participants_json:", sample.participants_json ? "yes" : "no");

const res = await base44.functions.invoke("get-trade-participants", {
  condition_id: sample.condition_id,
  outcome_index: sample.outcome_index,
  signal_at: sample.signal_at || sample.entry_at,
  strategy_id: sample.strategy_id,
});

if (res.data?.error) {
  console.log("FAIL get-trade-participants:", res.data.error);
  process.exit(1);
}

const participants = res.data?.participants || [];
console.log("  participants returned:", participants.length);
if (participants.length > 0) {
  console.log("  first wallet:", participants[0].label || participants[0].address?.slice(0, 10));
}

const liveAll = await base44.entities.PaperTrade.filter({ is_backtest: false, strategy_id: strict.strategy_id }, "-entry_at", 500);
const resolved = liveAll.filter((t) => t.status === "won" || t.status === "lost");
const staked = resolved.reduce((s, t) => s + Number(t.stake_usd || 0), 0);
const pnl = resolved.reduce((s, t) => s + Number(t.pnl_usd || 0), 0);
const liveRoi = staked > 0 ? pnl / staked : null;
console.log("Live paper computed:", resolved.length, "finished, roi:", liveRoi?.toFixed(3));

if (strict.resolved_trades > 1 && strict.roi != null) {
  console.log("OK: past stats use entity (not single trade)");
} else {
  console.log("WARN: past stats may be thin sample");
}

if (participants.length >= 1) {
  console.log("OK: wallet drill-down backend works");
} else {
  console.log("WARN: wallet drill-down returned empty (may need participants_json backfill)");
}
