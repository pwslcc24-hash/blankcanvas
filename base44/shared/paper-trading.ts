// Realistic paper-trade simulation: delay, slippage, fees, binary resolution.
// Backtests replay historical consensus clusters; forward mode uses live alerts.

import {
  classifySignalQuality,
  isFastMarket,
  type ConsensusGroup,
  type ConsensusParticipant,
} from "./consensus.ts";
import {
  fetchOfficialMarket,
  parseMarketOutcomes,
  resolutionFromOfficialMarket,
} from "./polymarket.ts";
import { computeWalletScoreAsOf } from "./scoring.ts";
import type { StrategyParams } from "./strategies.ts";
import { walletMatchesStrategy, walletMatchesStrategyFromScore } from "./strategies.ts";

export interface HistoricalCluster extends ConsensusGroup {
  detected_at_ms: number;
  quality: "strong" | "caution" | "blocked";
  price_drift: number | null;
  current_price: number | null;
}

export interface SimulatedTrade {
  trade_key: string;
  signal_key: string;
  condition_id: string;
  market_title?: string;
  market_slug?: string;
  outcome?: string;
  outcome_index?: number;
  wallet_count: number;
  participants_json?: string;
  status: "open" | "won" | "lost";
  signal_at: string;
  entry_at: string;
  entry_price: number;
  stake_usd: number;
  fee_usd: number;
  shares: number;
  vwap_skilled_entry: number;
  exit_at?: string;
  exit_price?: number;
  pnl_usd?: number;
}

export interface StrategyStats {
  total_trades: number;
  resolved_trades: number;
  open_trades: number;
  wins: number;
  losses: number;
  total_pnl_usd: number;
  total_staked_usd: number;
  roi: number;
  win_rate: number;
  avg_pnl_usd: number;
}

/** Find all consensus clusters in a lookback window (not just the last N hours). */
export function findHistoricalClusters(
  buys: any[],
  walletsByAddress: Map<string, any>,
  params: StrategyParams,
  now: Date = new Date(),
  activitiesByWallet?: Map<string, any[]>
): HistoricalCluster[] {
  const windowMs = params.windowHours * 3600 * 1000;
  const sinceMs = now.getTime() - params.lookbackDays * 86400000;
  const byMarket = new Map<string, Array<{ buy: any; wallet: any; t: number }>>();

  for (const buy of buys) {
    if (buy.event_type !== "TRADE" || buy.side !== "BUY") continue;
    if (!buy.condition_id || buy.outcome_index == null) continue;
    const wallet = walletsByAddress.get(buy.wallet_address);
    if (!wallet) continue;
    const t = buy.occurred_at ? new Date(buy.occurred_at).getTime() : NaN;
    if (!Number.isFinite(t) || t < sinceMs) continue;

    const key = `${buy.condition_id}|${buy.outcome_index}`;
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key)!.push({ buy, wallet, t });
  }

  const walletQualifiesAt = (wallet: any, signalMs: number): boolean => {
    if (!activitiesByWallet) return walletMatchesStrategy(wallet, params);
    const acts = activitiesByWallet.get(wallet.address) || [];
    const score = computeWalletScoreAsOf(wallet, acts, signalMs);
    return walletMatchesStrategyFromScore(
      { grade: score.grade, confidence: score.confidence },
      params
    );
  };

  const seen = new Set<string>();
  const clusters: HistoricalCluster[] = [];

  for (const [, rows] of byMarket) {
    rows.sort((a, b) => a.t - b.t);

    // Anchor each consensus on the last buy in the window
    for (let end = 0; end < rows.length; end++) {
      const activeWallets = new Map<string, typeof rows>();
      for (let start = end; start >= 0; start--) {
        if (rows[end].t - rows[start].t > windowMs) break;
        const addr = rows[start].buy.wallet_address;
        if (!activeWallets.has(addr)) activeWallets.set(addr, []);
        activeWallets.get(addr)!.push(rows[start]);
      }

      if (activeWallets.size < params.minWallets) continue;

      const signalMs = rows[end].t;
      // Re-check each wallet using only data available before the signal.
      for (const [address] of [...activeWallets]) {
        const wallet = walletsByAddress.get(address);
        if (!wallet || !walletQualifiesAt(wallet, signalMs)) {
          activeWallets.delete(address);
        }
      }
      if (activeWallets.size < params.minWallets) continue;

      let windowStartT = rows[end].t;
      for (let s = end; s >= 0; s--) {
        if (rows[end].t - rows[s].t > windowMs) break;
        windowStartT = rows[s].t;
      }

      const participants: ConsensusParticipant[] = [];
      let totalUsdc = 0;
      let weightedPrice = 0;

      for (const [address, walletRows] of activeWallets) {
        const best = walletRows.reduce((a, b) =>
          (Number(b.buy.usdc_size) || 0) > (Number(a.buy.usdc_size) || 0) ? b : a
        );
        const usdc = Number(best.buy.usdc_size) || 0;
        const price = Number(best.buy.price) || 0;
        totalUsdc += usdc;
        weightedPrice += price * usdc;
        participants.push({
          address,
          label: best.wallet.label,
          grade: best.wallet.skill_grade,
          score: best.wallet.skill_score,
          confidence: best.wallet.score_confidence,
          price,
          usdc_size: usdc,
          occurred_at: best.buy.occurred_at,
        });
      }

      if (params.minTotalUsdc && totalUsdc < params.minTotalUsdc) continue;

      const sample = rows[end].buy;
      const bucketMs = params.windowHours * 3600 * 1000;
      const signal_key = `${sample.condition_id}|${sample.outcome_index}|${Math.floor(windowStartT / bucketMs)}`;
      const dedupeKey = `${signal_key}|${end}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const vwap = totalUsdc > 0 ? weightedPrice / totalUsdc : 0;
      const lastBuyPrice = Number(rows[end].buy.price) || vwap;
      const priceDrift = lastBuyPrice - vwap;
      const fastMarket = isFastMarket(sample.market_title, sample.market_slug);
      const { quality } = classifySignalQuality({
        fastMarket,
        priceDrift,
        maxPriceDriftStrong: 0.02,
        maxPriceDriftCaution: 0.05,
      });

      if (!params.qualities.includes(quality)) continue;
      if (priceDrift != null && priceDrift > params.maxPriceDrift) continue;

      clusters.push({
        signal_key,
        condition_id: sample.condition_id,
        market_title: sample.market_title,
        market_slug: sample.market_slug,
        outcome: sample.outcome,
        outcome_index: sample.outcome_index,
        first_buy_at: new Date(windowStartT).toISOString(),
        last_buy_at: new Date(rows[end].t).toISOString(),
        wallet_count: activeWallets.size,
        participants,
        vwap_entry_price: vwap,
        total_usdc: totalUsdc,
        detected_at_ms: rows[end].t,
        quality,
        price_drift: priceDrift,
        current_price: lastBuyPrice,
      });
    }
  }

  // Dedupe overlapping clusters: keep highest wallet_count per signal_key
  const bestBySignal = new Map<string, HistoricalCluster>();
  for (const c of clusters) {
    const prev = bestBySignal.get(c.signal_key);
    if (!prev || c.wallet_count > prev.wallet_count || c.detected_at_ms > prev.detected_at_ms) {
      bestBySignal.set(c.signal_key, c);
    }
  }

  return Array.from(bestBySignal.values()).sort((a, b) => a.detected_at_ms - b.detected_at_ms);
}

/** Wallets + buys that formed a consensus signal at a point in time (for trade drill-down). */
export function buildParticipantsForSignal(
  buys: any[],
  walletsByAddress: Map<string, any>,
  params: StrategyParams,
  conditionId: string,
  outcomeIndex: number,
  signalAt: string
): ConsensusParticipant[] {
  const signalMs = new Date(signalAt).getTime();
  const windowMs = params.windowHours * 3600 * 1000;
  const sinceMs = signalMs - windowMs;
  const byWallet = new Map<string, any[]>();

  for (const buy of buys) {
    if (buy.event_type !== "TRADE" || buy.side !== "BUY") continue;
    if (buy.condition_id !== conditionId || buy.outcome_index !== outcomeIndex) continue;
    const wallet = walletsByAddress.get(buy.wallet_address);
    if (!wallet || !walletMatchesStrategy(wallet, params)) continue;
    const t = buy.occurred_at ? new Date(buy.occurred_at).getTime() : NaN;
    if (!Number.isFinite(t) || t < sinceMs || t > signalMs) continue;
    if (!byWallet.has(buy.wallet_address)) byWallet.set(buy.wallet_address, []);
    byWallet.get(buy.wallet_address)!.push({ buy, wallet, t });
  }

  const participants: ConsensusParticipant[] = [];
  for (const [address, walletRows] of byWallet) {
    const best = walletRows.reduce((a, b) =>
      (Number(b.buy.usdc_size) || 0) > (Number(a.buy.usdc_size) || 0) ? b : a
    );
    participants.push({
      address,
      label: best.wallet.label,
      grade: best.wallet.skill_grade,
      score: best.wallet.skill_score,
      confidence: best.wallet.score_confidence,
      price: Number(best.buy.price) || 0,
      usdc_size: Number(best.buy.usdc_size) || 0,
      occurred_at: best.buy.occurred_at,
    });
  }

  participants.sort((a, b) => (b.score || 0) - (a.score || 0));
  return participants;
}

export function resolveTradeOutcome(
  _conditionId: string,
  outcomeIndex: number,
  _entryMs: number,
  _activities: any[],
  closedPrice?: number | null,
  marketClosed?: boolean
): { status: "open" | "won" | "lost"; exit_price?: number; exit_at?: string } {
  // Only settle when the official market is closed. Live 95¢ favorites are not results.
  if (!marketClosed) return { status: "open" };
  if (closedPrice == null || !Number.isFinite(closedPrice)) return { status: "open" };
  if (closedPrice >= 0.95) {
    return { status: "won", exit_price: 1, exit_at: new Date().toISOString() };
  }
  if (closedPrice <= 0.05) {
    return { status: "lost", exit_price: 0, exit_at: new Date().toISOString() };
  }
  return { status: "open" };
}

/** Resolve from Polymarket's official Gamma record only. No wallet-redeem guesses. */
export async function resolveOpenTrade(
  trade: any,
  _activities: any[] = []
): Promise<{ status: "open" | "won" | "lost"; exit_price?: number; exit_at?: string }> {
  const market = await fetchOfficialMarket(trade.condition_id, trade.market_slug);
  return resolutionFromOfficialMarket(market, trade.outcome_index ?? 0);
}

export function officialFieldsFromMarket(market: any, outcomeIndex: number) {
  if (!market) return {};
  const { labels } = parseMarketOutcomes(market);
  const patch: Record<string, any> = {};
  if (market.question) patch.market_title = market.question;
  if (market.slug) patch.market_slug = market.slug;
  if (labels[outcomeIndex]) patch.outcome = labels[outcomeIndex];
  return patch;
}

/** Compare a stored paper trade to the official market and return a correction, or null. */
export async function factCheckPaperTrade(trade: any): Promise<Record<string, any> | null> {
  const market = await fetchOfficialMarket(trade.condition_id, trade.market_slug);
  const official = resolutionFromOfficialMarket(market, trade.outcome_index ?? 0);
  const fields = officialFieldsFromMarket(market, trade.outcome_index ?? 0);

  if (!market) {
    if (trade.status === "won" || trade.status === "lost") {
      return {
        status: "open",
        exit_at: null,
        exit_price: null,
        pnl_usd: null,
        ...fields,
      };
    }
    return Object.keys(fields).length ? fields : null;
  }

  if (official.status === "open") {
    if (trade.status === "won" || trade.status === "lost") {
      return {
        status: "open",
        exit_at: null,
        exit_price: null,
        pnl_usd: null,
        ...fields,
      };
    }
    return Object.keys(fields).length ? fields : null;
  }

  const patch = applyPaperTradeResolution(trade, official);
  if (!patch) return Object.keys(fields).length ? fields : null;

  const same =
    trade.status === patch.status &&
    Number(trade.exit_price) === Number(patch.exit_price) &&
    Number(trade.pnl_usd) === Number(patch.pnl_usd);
  const titleSame = !fields.market_title || fields.market_title === trade.market_title;
  const outcomeSame = !fields.outcome || fields.outcome === trade.outcome;
  if (same && titleSame && outcomeSame) return null;
  return { ...patch, ...fields };
}

export function applyPaperTradeResolution(
  trade: any,
  resolution: { status: "open" | "won" | "lost"; exit_price?: number; exit_at?: string }
) {
  if (resolution.status === "open") return null;
  const exitPrice = resolution.exit_price ?? 0;
  const proceeds = (trade.shares || 0) * exitPrice;
  const pnl = Math.round((proceeds - (trade.stake_usd || 0)) * 100) / 100;
  return {
    status: resolution.status,
    exit_at: resolution.exit_at,
    exit_price: exitPrice,
    pnl_usd: pnl,
  };
}

export async function refreshBacktestStrategyStats(base44: any, strategyIds: string[]) {
  const unique = [...new Set(strategyIds.filter(Boolean))];
  const now = new Date().toISOString();
  for (const strategyId of unique) {
    const trades = await base44.entities.PaperTrade.filter(
      { strategy_id: strategyId, is_backtest: true },
      "-entry_at",
      2500
    );
    const stats = aggregateStats(trades);
    const rows = await base44.entities.PaperStrategy.filter({ strategy_id: strategyId });
    if (rows.length) {
      await base44.entities.PaperStrategy.update(rows[0].id, {
        ...stats,
        last_backtest_at: now,
      });
    }
  }
}

export function simulatePaperTrade(
  cluster: HistoricalCluster | ConsensusGroup,
  strategyId: string,
  params: StrategyParams,
  resolution: { status: "open" | "won" | "lost"; exit_price?: number; exit_at?: string },
  entryPriceOverride?: number
): SimulatedTrade {
  const signalMs = new Date(cluster.last_buy_at).getTime();
  const entryMs = signalMs + params.delaySec * 1000;
  const entryPrice =
    entryPriceOverride != null && Number.isFinite(entryPriceOverride)
      ? Math.min(0.99, Math.max(0.01, entryPriceOverride))
      : Math.min(0.99, Math.max(0.01, cluster.vwap_entry_price + params.slippage));
  const stake = params.stakeUsd;
  const fee = stake * params.feeRate;
  const shares = (stake - fee) / entryPrice;

  const trade: SimulatedTrade = {
    trade_key: `${strategyId}|${cluster.signal_key}`,
    signal_key: cluster.signal_key,
    condition_id: cluster.condition_id,
    market_title: cluster.market_title,
    market_slug: cluster.market_slug,
    outcome: cluster.outcome,
    outcome_index: cluster.outcome_index,
    wallet_count: cluster.wallet_count,
    participants_json: JSON.stringify(cluster.participants || []),
    status: resolution.status,
    signal_at: cluster.last_buy_at,
    entry_at: new Date(entryMs).toISOString(),
    entry_price: Math.round(entryPrice * 10000) / 10000,
    stake_usd: stake,
    fee_usd: Math.round(fee * 100) / 100,
    shares: Math.round(shares * 100) / 100,
    vwap_skilled_entry: cluster.vwap_entry_price,
  };

  if (resolution.status === "won" || resolution.status === "lost") {
    const exitPrice = resolution.exit_price ?? 0;
    const proceeds = shares * exitPrice;
    trade.exit_at = resolution.exit_at;
    trade.exit_price = exitPrice;
    trade.pnl_usd = Math.round((proceeds - stake) * 100) / 100;
  } else {
    trade.exit_at = undefined;
    trade.exit_price = undefined;
    trade.pnl_usd = undefined;
  }

  return trade;
}

export function aggregateStats(trades: SimulatedTrade[]): StrategyStats {
  const resolved = trades.filter((t) => t.status === "won" || t.status === "lost");
  const wins = resolved.filter((t) => t.status === "won").length;
  const losses = resolved.filter((t) => t.status === "lost").length;
  const totalPnl = resolved.reduce((s, t) => s + (t.pnl_usd || 0), 0);
  const totalStaked = resolved.reduce((s, t) => s + t.stake_usd, 0);

  return {
    total_trades: trades.length,
    resolved_trades: resolved.length,
    open_trades: trades.filter((t) => t.status === "open").length,
    wins,
    losses,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    total_staked_usd: Math.round(totalStaked * 100) / 100,
    roi: totalStaked > 0 ? Math.round((totalPnl / totalStaked) * 10000) / 10000 : 0,
    win_rate: resolved.length > 0 ? Math.round((wins / resolved.length) * 1000) / 1000 : 0,
    avg_pnl_usd:
      resolved.length > 0 ? Math.round((totalPnl / resolved.length) * 100) / 100 : 0,
  };
}

