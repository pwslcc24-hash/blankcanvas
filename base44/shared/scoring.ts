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
  buyCostUsd: number; // TRADE/BUY only — used to derive the market-implied entry price
  buyShares: number; // TRADE/BUY only
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
  calibration_edge: number;
  calibrated_market_count: number;
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
  // A position row that has resolved (redeemable === true) is a market the
  // wallet has already won or lost — nobody bothers to claim a worthless
  // token, so losses in particular pile up here unredeemed forever. Treating
  // every position row as "still open" (the old behavior) silently dropped
  // those confirmed losses from the score while wins, which do get redeemed
  // and disappear from this table, still counted. Only genuinely unresolved
  // positions (redeemable === false) should be excluded as "open".
  const openConditions = new Set<string>();
  const resolvedUnclaimedValueByCondition = new Map<string, number>();
  for (const p of positions) {
    if (!p.condition_id) continue;
    if (p.redeemable) {
      resolvedUnclaimedValueByCondition.set(
        p.condition_id,
        (resolvedUnclaimedValueByCondition.get(p.condition_id) || 0) +
          Number(p.current_value_usd || 0)
      );
    } else {
      openConditions.add(p.condition_id);
    }
  }

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
        buyCostUsd: 0,
        buyShares: 0,
      };
      markets.set(conditionId, agg);
    }
    if (Number.isFinite(ts)) {
      agg.firstActivityAt = Math.min(agg.firstActivityAt, ts);
      agg.lastActivityAt = Math.max(agg.lastActivityAt, ts);
    }

    const usdc = Number(a.usdc_size || 0);
    if (a.event_type === "TRADE") {
      if (a.side === "BUY") {
        agg.inflowUsd += usdc;
        // Only direct market buys carry a real "price paid" — splits mint
        // both outcome tokens for $1 combined and aren't a directional bet,
        // so they're excluded from the implied-probability calculation below.
        agg.buyCostUsd += usdc;
        agg.buyShares += Number(a.size || 0);
      } else if (a.side === "SELL") agg.outflowUsd += usdc;
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

  // Calibration: was this wallet actually right more often than the price it
  // paid implied? Buying at $0.90 and winning 90% of the time is the market
  // being right, not skill — real edge is winning MORE than your own average
  // entry price implied. Summing (outcome - impliedProbability) across
  // markets and averaging gives that edge directly (a Brier-style residual).
  let calibrationSum = 0;
  let calibratedMarketCount = 0;

  for (const agg of markets.values()) {
    // Only markets the wallet actually deployed capital into and fully exited.
    if (openConditions.has(agg.conditionId) || agg.inflowUsd <= 0) continue;

    // Resolved-but-unredeemed value (see resolvedUnclaimedValueByCondition
    // above) is real cash the wallet is entitled to (zero on a loss, full
    // payout on a win) — count it as if it had been redeemed.
    const effectiveOutflow =
      agg.outflowUsd + (resolvedUnclaimedValueByCondition.get(agg.conditionId) || 0);
    const profit = effectiveOutflow - agg.inflowUsd;
    closedCount += 1;
    totalProfit += profit;
    buyVolume += agg.inflowUsd;
    const won = profit > 0.01;
    if (won) {
      wins += 1;
      maxMarketProfit = Math.max(maxMarketProfit, profit);
    }

    if (agg.buyShares > 0) {
      const impliedProb = clamp01(agg.buyCostUsd / agg.buyShares);
      calibrationSum += (won ? 1 : 0) - impliedProb;
      calibratedMarketCount += 1;
    }

    if (agg.firstActivityAt >= trackedSinceMs) {
      oosClosedCount += 1;
      oosProfit += profit;
      if (profit > 0.01) oosWins += 1;
    }
  }

  const calibrationEdge =
    calibratedMarketCount > 0 ? calibrationSum / calibratedMarketCount : 0;

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
    // Centered on 0 edge = market-implied odds, no skill. +-0.15 average
    // edge per market is a large, sustained edge for a prediction market.
    const calibrationComponent =
      calibratedMarketCount > 0
        ? clamp01((calibrationEdge + 0.15) / 0.3) * 25
        : 0;
    const rocComponent = clamp01((roc + 0.1) / 0.4) * 25;
    const concentrationComponent =
      totalProfit > 0 ? (1 - concentration) * 20 : 0;
    const diversityComponent =
      clamp01(markets.size / 40) * 10 + clamp01(spanDays / 60) * 5;
    score =
      sampleComponent +
      calibrationComponent +
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
    calibration_edge: round(calibrationEdge),
    calibrated_market_count: calibratedMarketCount,
  };
}
