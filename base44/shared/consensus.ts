// Consensus detection for Stage 3: fire when multiple independently skilled
// wallets buy the same outcome within a rolling window. Filters mirror the
// research-backed rules (slow markets, price-drift cap, grade/confidence gate).

export interface ConsensusParticipant {
  address: string;
  label?: string;
  grade?: string;
  score?: number;
  confidence?: string;
  price: number;
  usdc_size: number;
  occurred_at: string;
}

export interface ConsensusGroup {
  signal_key: string;
  condition_id: string;
  market_title?: string;
  market_slug?: string;
  outcome?: string;
  outcome_index?: number;
  first_buy_at: string;
  last_buy_at: string;
  wallet_count: number;
  participants: ConsensusParticipant[];
  vwap_entry_price: number;
  total_usdc: number;
}

export interface ConsensusDetectOptions {
  windowHours?: number;
  minWallets?: number;
  maxPriceDriftStrong?: number;
  maxPriceDriftCaution?: number;
  now?: Date;
}

const DEFAULT_OPTS: Required<Omit<ConsensusDetectOptions, "now">> = {
  windowHours: 6,
  minWallets: 3,
  maxPriceDriftStrong: 0.02,
  maxPriceDriftCaution: 0.05,
};

/** Grade A/B with medium+ confidence — the pool we treat as "skilled" for consensus. */
export function isSkilledForConsensus(wallet: any): boolean {
  const grade = wallet?.skill_grade;
  const conf = wallet?.score_confidence;
  if (!grade || !conf) return false;
  if (grade !== "A" && grade !== "B") return false;
  return conf === "medium" || conf === "high";
}

/** Heuristic fast-market filter (5-min crypto, up/down, etc.). Imperfect but cheap. */
export function isFastMarket(title?: string, slug?: string): boolean {
  const text = `${title || ""} ${slug || ""}`.toLowerCase();
  const patterns = [
    /\b(btc|eth|bitcoin|ethereum|solana|xrp|doge)\b.*\b(up|down|above|below|price)\b/,
    /\bup or down\b/,
    /\b5[\s-]?min(ute)?s?\b/,
    /\b15[\s-]?min(ute)?s?\b/,
    /\b1[\s-]?hour\b/,
    /\bhourly\b/,
    /\bevery (5|15|30|60) min/,
  ];
  return patterns.some((p) => p.test(text));
}

export function buildSignalKey(
  conditionId: string,
  outcomeIndex: number,
  windowStartMs: number,
  windowHours: number
): string {
  const bucketMs = windowHours * 3600 * 1000;
  const bucket = Math.floor(windowStartMs / bucketMs);
  return `${conditionId}|${outcomeIndex}|${bucket}`;
}

export function classifySignalQuality(opts: {
  fastMarket: boolean;
  priceDrift: number | null;
  maxPriceDriftStrong: number;
  maxPriceDriftCaution: number;
}): { quality: "strong" | "caution" | "blocked"; block_reason?: string } {
  if (opts.fastMarket) {
    return { quality: "blocked", block_reason: "Fast/volatile market (crypto up-down, short duration)" };
  }
  if (opts.priceDrift == null || !Number.isFinite(opts.priceDrift)) {
    return { quality: "caution", block_reason: "Current price unavailable — verify manually before acting" };
  }
  if (opts.priceDrift > opts.maxPriceDriftCaution) {
    return {
      quality: "blocked",
      block_reason: `Price moved ${(opts.priceDrift * 100).toFixed(1)}¢ past skilled entry (max ${(opts.maxPriceDriftCaution * 100).toFixed(0)}¢)`,
    };
  }
  if (opts.priceDrift > opts.maxPriceDriftStrong) {
    return {
      quality: "caution",
      block_reason: `Price drift ${(opts.priceDrift * 100).toFixed(1)}¢ — edge may be gone`,
    };
  }
  return { quality: "strong" };
}

/**
 * Groups recent skilled-wallet BUY rows into consensus candidates.
 * Only TRADE/BUY events within the lookback window are considered.
 */
export function detectConsensusGroups(
  buys: any[],
  walletsByAddress: Map<string, any>,
  options: ConsensusDetectOptions = {}
): ConsensusGroup[] {
  const opts = { ...DEFAULT_OPTS, ...options };
  const nowMs = (options.now || new Date()).getTime();
  const windowMs = opts.windowHours * 3600 * 1000;
  const sinceMs = nowMs - windowMs;

  const byMarket = new Map<string, any[]>();

  for (const buy of buys) {
    if (buy.event_type !== "TRADE" || buy.side !== "BUY") continue;
    if (!buy.condition_id || buy.outcome_index == null) continue;
    const wallet = walletsByAddress.get(buy.wallet_address);
    if (!wallet || !isSkilledForConsensus(wallet)) continue;
    const t = buy.occurred_at ? new Date(buy.occurred_at).getTime() : NaN;
    if (!Number.isFinite(t) || t < sinceMs) continue;

    const key = `${buy.condition_id}|${buy.outcome_index}`;
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key)!.push({ buy, wallet, t });
  }

  const groups: ConsensusGroup[] = [];

  for (const [, rows] of byMarket) {
    rows.sort((a, b) => a.t - b.t);

    // Distinct wallets in the full window
    const byWallet = new Map<string, typeof rows>();
    for (const row of rows) {
      const addr = row.buy.wallet_address;
      if (!byWallet.has(addr)) byWallet.set(addr, []);
      byWallet.get(addr)!.push(row);
    }
    if (byWallet.size < opts.minWallets) continue;

    const first = rows[0];
    const last = rows[rows.length - 1];
    if (last.t - first.t > windowMs) continue;

    const participants: ConsensusParticipant[] = [];
    let totalUsdc = 0;
    let weightedPrice = 0;

    for (const [address, walletRows] of byWallet) {
      // Use each wallet's largest buy in this window for VWAP
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

    participants.sort((a, b) => (b.score || 0) - (a.score || 0));

    const sample = first.buy;
    groups.push({
      signal_key: buildSignalKey(
        sample.condition_id,
        sample.outcome_index,
        first.t,
        opts.windowHours
      ),
      condition_id: sample.condition_id,
      market_title: sample.market_title,
      market_slug: sample.market_slug,
      outcome: sample.outcome,
      outcome_index: sample.outcome_index,
      first_buy_at: first.buy.occurred_at,
      last_buy_at: last.buy.occurred_at,
      wallet_count: byWallet.size,
      participants,
      vwap_entry_price: totalUsdc > 0 ? weightedPrice / totalUsdc : 0,
      total_usdc: totalUsdc,
    });
  }

  groups.sort((a, b) => b.wallet_count - a.wallet_count || b.total_usdc - a.total_usdc);
  return groups;
}
