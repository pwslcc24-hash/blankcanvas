const res = await base44.functions.invoke("backtest-strategies", { full: true });
const d = res.data || {};
console.log(`Fetched ${d.buysSampled} buys, ${d.redeemsSampled} redeems, ${d.processed} strategies`);
const proven = (d.summary || [])
  .filter((s) => (s.resolved_trades || 0) >= 5)
  .sort((a, b) => (b.roi || 0) - (a.roi || 0));
console.log("\nTOP PROVEN STRATEGIES:");
for (const s of proven.slice(0, 10)) {
  console.log(
    `${s.name}: ROI ${((s.roi || 0) * 100).toFixed(1)}%, win ${((s.win_rate || 0) * 100).toFixed(0)}%, PnL $${s.total_pnl_usd}, n=${s.resolved_trades}`
  );
}
