// Skill-scoring engine for tracked wallets (Stage 2 of the smart-wallet
// consensus plan).
//
// Works entirely from synced WalletActivity + WalletPosition rows. A market is
// "closed" when the wallet has no remaining open position in it; realized
// profit is cash-out (sells + merges + redeems) minus cash-in (buys + splits).
//
// Deliberate design choices, per the research this project is based on:
//  - Return on capital matters more than raw dollar profit.
//  - One giant win should NOT produce a high score (profit concentration
//    penalty), because lottery winners aren't skill.
//  - Out-of-sample (OOS) metrics only count markets first traded AFTER the
//    wallet was added to tracking — the only honest forward-test signal.
//  - Scores from thin data are flagged "insufficient"/"low" confidence; the
//    synced history is capped by the Data API (500 most recent events per
//    sync), so early scores are provisional until history accumulates.

interface MarketAggregate {
  conditionId: string;
  inflowUsd: number; // buys + splits (cash deployed)
  outflowUsd: number; // sells + merges + redeems (cash recovered)
  firstActivityAt: number; // ms epoch
  lastActivityAt: number; // ms epoch
}

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
}

const CASH_IN_TYPES = new Set(["SPLIT"]);
const CASH_OUT_TYPES = new Set(["MERGE", "REDEEM"]);

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round(x: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

export function computeWalletScore(
  wallet: any,
  activities: any[],
  positions: any[]
): WalletScoreResult {
  const openConditions = new Set(
    positions.map((p) => p.condition_id).filter(Boolean)
  );

  const markets = new Map<string, MarketAggregate>();
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const a of activities) {
    const conditionId = a.condition_id;
    const ts = a.occurred_at ? new Date(a.occurred_at).getTime() : NaN;
    if (Number.isFinite(ts)) {
      minTs = Math.min(minTs, ts);
      maxTs = Math.max(maxTs, ts);
    }
    if (!conditionId) continue;
    // REWARD/CONVERSION are not directional trading decisions — exclude them
    // from per-market profit so liquidity rewards don't inflate "skill".
    if (a.event_type === "REWARD" || a.event_type === "CONVERSION") continue;

    let agg = markets.get(conditionId);
    if (!agg) {
      agg = {
        conditionId,
        inflowUsd: 0,
        outflowUsd: 0,
        firstActivityAt: Infinity,
        lastActivityAt: -Infinity,
      };
      markets.set(conditionId, agg);
    }
    if (Number.isFinite(ts)) {
      agg.firstActivityAt = Math.min(agg.firstActivityAt, ts);
      agg.lastActivityAt = Math.max(agg.lastActivityAt, ts);
    }

    const usdc = Number(a.usdc_size || 0);
    if (a.event_type === "TRADE") {
      if (a.side === "BUY") agg.inflowUsd += usdc;
      else if (a.side === "SELL") agg.outflowUsd += usdc;
    } else if (CASH_IN_TYPES.has(a.event_type)) {
      agg.inflowUsd += usdc;
    } else if (CASH_OUT_TYPES.has(a.event_type)) {
      agg.outflowUsd += usdc;
    }
  }

  const trackedSinceMs = wallet.created_date
    ? new Date(wallet.created_date).getTime()
    : Infinity;

  let closedCount = 0;
  let wins = 0;
  let totalProfit = 0;
  let buyVolume = 0;
  let maxMarketProfit = 0;

  let oosClosedCount = 0;
  let oosWins = 0;
  let oosProfit = 0;

  for (const agg of markets.values()) {
    // Only markets the wallet actually deployed capital into and fully exited.
    if (openConditions.has(agg.conditionId) || agg.inflowUsd <= 0) continue;

    const profit = agg.outflowUsd - agg.inflowUsd;
    closedCount += 1;
    totalProfit += profit;
    buyVolume += agg.inflowUsd;
    if (profit > 0.01) {
      wins += 1;
      maxMarketProfit = Math.max(maxMarketProfit, profit);
    }

    if (agg.firstActivityAt >= trackedSinceMs) {
      oosClosedCount += 1;
      oosProfit += profit;
      if (profit > 0.01) oosWins += 1;
    }
  }

  const winRate = closedCount > 0 ? wins / closedCount : 0;
  const roc = buyVolume > 0 ? totalProfit / buyVolume : 0;
  const concentration =
    totalProfit > 0 ? clamp01(maxMarketProfit / totalProfit) : 1;
  const spanDays =
    Number.isFinite(minTs) && Number.isFinite(maxTs) && maxTs > minTs
      ? (maxTs - minTs) / 86_400_000
      : 0;

  let confidence: WalletScoreResult["confidence"];
  if (closedCount < 10) confidence = "insufficient";
  else if (closedCount < 30) confidence = "low";
  else if (closedCount < 75) confidence = "medium";
  else confidence = "high";

  let score = 0;
  if (closedCount > 0) {
    const sampleComponent = clamp01(closedCount / 50) * 15;
    const winComponent = clamp01((winRate - 0.3) / 0.4) * 20;
    const rocComponent = clamp01((roc + 0.1) / 0.4) * 30;
    const concentrationComponent =
      totalProfit > 0 ? (1 - concentration) * 20 : 0;
    const diversityComponent =
      clamp01(markets.size / 40) * 10 + clamp01(spanDays / 60) * 5;
    score =
      sampleComponent +
      winComponent +
      rocComponent +
      concentrationComponent +
      diversityComponent;
  }
  score = Math.round(score * 10) / 10;

  const grade =
    score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : score >= 35 ? "D" : "F";

  return {
    score,
    grade,
    confidence,
    closed_market_count: closedCount,
    win_rate: round(winRate),
    realized_profit_usd: round(totalProfit, 2),
    buy_volume_usd: round(buyVolume, 2),
    return_on_capital: round(roc),
    profit_concentration: round(concentration),
    distinct_markets: markets.size,
    activity_span_days: round(spanDays, 1),
    oos_closed_market_count: oosClosedCount,
    oos_realized_profit_usd: round(oosProfit, 2),
    oos_win_rate: round(oosClosedCount > 0 ? oosWins / oosClosedCount : 0),
  };
}
