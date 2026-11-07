// Letter grades for tracked wallets.
//
// A grade counts only bets placed after we started watching the wallet, and
// only once Polymarket has officially settled that bet. Selling early does not
// count. The wallet has to beat the price it paid. Until 30 of those settled
// bets exist, the grade stays blank so an old lucky record cannot trigger a play.

export interface WalletScoreResult {
  score: number;
  grade: string;
  confidence: "insufficient" | "low" | "medium" | "high";
  closed_market_count: number;
  win_rate: number;
  realized_profit_usd: number;
  buy_volume_usd: number;
  return_on_capital: number;
  profit_concentration: number;
  distinct_markets: number;
  activity_span_days: number;
  oos_closed_market_count: number;
  oos_realized_profit_usd: number;
  oos_win_rate: number;
  calibration_edge: number;
  calibrated_market_count: number;
}

/** Finished watched bets required before a letter grade is assigned. */
export const MIN_WATCHED_MARKETS = 30;

interface SideBook {
  buyCostUsd: number;
  buyShares: number;
  firstBuyAt: number;
  lastBuyAt: number;
  redeemed: boolean;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round(x: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

function sideKey(conditionId: string, outcomeIndex: number): string {
  return `${conditionId}|${outcomeIndex}`;
}

function emptyScore(): WalletScoreResult {
  return {
    score: 0,
    grade: "",
    confidence: "insufficient",
    closed_market_count: 0,
    win_rate: 0,
    realized_profit_usd: 0,
    buy_volume_usd: 0,
    return_on_capital: 0,
    profit_concentration: 1,
    distinct_markets: 0,
    activity_span_days: 0,
    oos_closed_market_count: 0,
    oos_realized_profit_usd: 0,
    oos_win_rate: 0,
    calibration_edge: 0,
    calibrated_market_count: 0,
  };
}

/** Official win/loss for the side this wallet bought. Early sales stay unknown. */
export function officialSideResult(
  position: any | null,
  redeemed: boolean
): "won" | "lost" | "open" | "unknown" {
  if (position && !position.redeemable) return "open";
  if (position && position.redeemable) {
    const price = Number(position.current_price);
    if (Number.isFinite(price) && price >= 0.99) return "won";
    if (Number.isFinite(price) && price <= 0.01) return "lost";
    return "open";
  }
  if (redeemed) return "won";
  return "unknown";
}

export function computeWalletScore(
  wallet: any,
  activities: any[],
  positions: any[]
): WalletScoreResult {
  const trackedSinceMs = wallet?.created_date
    ? new Date(wallet.created_date).getTime()
    : Infinity;

  const sides = new Map<string, SideBook>();
  const positionsBySide = new Map<string, any>();

  for (const p of positions || []) {
    if (!p?.condition_id || p.outcome_index == null) continue;
    positionsBySide.set(sideKey(p.condition_id, Number(p.outcome_index)), p);
  }

  for (const a of activities || []) {
    if (!a?.condition_id || a.outcome_index == null) continue;
    const key = sideKey(a.condition_id, Number(a.outcome_index));
    const ts = a.occurred_at ? new Date(a.occurred_at).getTime() : NaN;

    if (a.event_type === "REDEEM") {
      const book = sides.get(key) || {
        buyCostUsd: 0,
        buyShares: 0,
        firstBuyAt: Infinity,
        lastBuyAt: -Infinity,
        redeemed: false,
      };
      book.redeemed = true;
      sides.set(key, book);
      continue;
    }

    if (a.event_type !== "TRADE" || a.side !== "BUY") continue;

    const book = sides.get(key) || {
      buyCostUsd: 0,
      buyShares: 0,
      firstBuyAt: Infinity,
      lastBuyAt: -Infinity,
      redeemed: false,
    };
    book.buyCostUsd += Number(a.usdc_size || 0);
    book.buyShares += Number(a.size || 0);
    if (Number.isFinite(ts)) {
      book.firstBuyAt = Math.min(book.firstBuyAt, ts);
      book.lastBuyAt = Math.max(book.lastBuyAt, ts);
    }
    sides.set(key, book);
  }

  let closedCount = 0;
  let wins = 0;
  let totalProfit = 0;
  let buyVolume = 0;
  let maxMarketProfit = 0;
  let calibrationSum = 0;
  let calibratedMarketCount = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const [key, book] of sides) {
    if (book.buyCostUsd <= 0 || book.buyShares <= 0) continue;
    if (!Number.isFinite(book.firstBuyAt) || book.firstBuyAt < trackedSinceMs) continue;

    const result = officialSideResult(positionsBySide.get(key) || null, book.redeemed);
    if (result !== "won" && result !== "lost") continue;

    const won = result === "won";
    const profit = (won ? book.buyShares : 0) - book.buyCostUsd;
    closedCount += 1;
    totalProfit += profit;
    buyVolume += book.buyCostUsd;
    if (won) {
      wins += 1;
      maxMarketProfit = Math.max(maxMarketProfit, profit);
    }
    const implied = clamp01(book.buyCostUsd / book.buyShares);
    calibrationSum += (won ? 1 : 0) - implied;
    calibratedMarketCount += 1;
    minTs = Math.min(minTs, book.firstBuyAt);
    if (Number.isFinite(book.lastBuyAt)) maxTs = Math.max(maxTs, book.lastBuyAt);
  }

  const calibrationEdge = calibratedMarketCount > 0 ? calibrationSum / calibratedMarketCount : 0;
  const winRate = closedCount > 0 ? wins / closedCount : 0;
  const roc = buyVolume > 0 ? totalProfit / buyVolume : 0;
  const concentration = totalProfit > 0 ? clamp01(maxMarketProfit / totalProfit) : 1;
  const spanDays =
    Number.isFinite(minTs) && Number.isFinite(maxTs) && maxTs > minTs
      ? (maxTs - minTs) / 86_400_000
      : 0;

  const base = emptyScore();
  base.closed_market_count = closedCount;
  base.win_rate = round(winRate);
  base.realized_profit_usd = round(totalProfit, 2);
  base.buy_volume_usd = round(buyVolume, 2);
  base.return_on_capital = round(roc);
  base.profit_concentration = round(concentration);
  base.distinct_markets = closedCount;
  base.activity_span_days = round(spanDays, 1);
  base.oos_closed_market_count = closedCount;
  base.oos_realized_profit_usd = round(totalProfit, 2);
  base.oos_win_rate = round(winRate);
  base.calibration_edge = round(calibrationEdge);
  base.calibrated_market_count = calibratedMarketCount;

  if (closedCount < MIN_WATCHED_MARKETS) return base;

  const sampleComponent = clamp01(closedCount / 50) * 15;
  const calibrationComponent = clamp01((calibrationEdge + 0.15) / 0.3) * 25;
  const rocComponent = clamp01((roc + 0.1) / 0.4) * 25;
  const concentrationComponent = totalProfit > 0 ? (1 - concentration) * 20 : 0;
  const diversityComponent = clamp01(closedCount / 40) * 10 + clamp01(spanDays / 60) * 5;
  const score =
    Math.round(
      (sampleComponent + calibrationComponent + rocComponent + concentrationComponent + diversityComponent) * 10
    ) / 10;

  let confidence: WalletScoreResult["confidence"] = "medium";
  if (closedCount >= 75) confidence = "high";

  const grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : score >= 35 ? "D" : "F";

  return { ...base, score, grade, confidence };
}

/**
 * Point-in-time grade for backtests. Without the position snapshot from that
 * day we cannot see official losses, so the grade stays blank. Old backtests
 * no longer invent an A from a wallet's past.
 */
export function computeWalletScoreAsOf(
  wallet: any,
  activities: any[],
  asOfMs: number
): WalletScoreResult {
  const filtered = (activities || []).filter((a) => {
    const t = a.occurred_at ? new Date(a.occurred_at).getTime() : NaN;
    return Number.isFinite(t) && t < asOfMs;
  });
  const scored = computeWalletScore(wallet, filtered, []);
  return { ...scored, score: 0, grade: "", confidence: "insufficient" };
}
