// Shared helpers for talking to Polymarket's public Data API
// (https://data-api.polymarket.com). No API key required — these are
// read-only, publicly documented endpoints.

export const DATA_API = "https://data-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";

export function normalizeAddress(address: string): string {
  return (address || "").trim().toLowerCase();
}

export function toIso(unixSeconds: number): string | undefined {
  if (!unixSeconds && unixSeconds !== 0) return undefined;
  return new Date(unixSeconds * 1000).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polymarket's Data API rate-limits aggressively under bursty load (we've
 * seen 429s after ~10 back-to-back batches). Retry with backoff instead of
 * failing the whole wallet immediately.
 */
async function getJson(url: string, attempt = 1): Promise<any> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429 && attempt <= 3) {
    await sleep(500 * 2 ** attempt);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Polymarket API request failed (${res.status}): ${url}`);
  }
  return res.json();
}

function unwrapList(data: any): any[] {
  if (Array.isArray(data)) return data;
  return data?.data || data?.leaderboard || data?.entries || [];
}

/** Polymarket's own all-time (or filtered) leaderboard entry for a single wallet, if ranked. */
export async function fetchLeaderboardStats(address: string): Promise<any | null> {
  const params = new URLSearchParams({
    user: address,
    timePeriod: "ALL",
    orderBy: "PNL",
    limit: "1",
  });
  const data = await getJson(`${DATA_API}/v1/leaderboard?${params.toString()}`);
  const entries = unwrapList(data);
  return entries[0] || null;
}

/** Raw leaderboard page for discovery (top wallets by PNL or VOL). */
export async function fetchLeaderboardPage(opts: {
  category?: string;
  timePeriod?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
}): Promise<any[]> {
  const params = new URLSearchParams({
    category: opts.category || "OVERALL",
    timePeriod: opts.timePeriod || "ALL",
    orderBy: opts.orderBy || "PNL",
    limit: String(opts.limit || 25),
    offset: String(opts.offset || 0),
  });
  const data = await getJson(`${DATA_API}/v1/leaderboard?${params.toString()}`);
  return unwrapList(data);
}

/** Recent on-chain activity for a wallet (trades, splits, merges, redeems, rewards, conversions). */
export async function fetchActivity(address: string, limit = 500): Promise<any[]> {
  const params = new URLSearchParams({
    user: address,
    limit: String(Math.min(limit, 500)),
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });
  const data = await getJson(`${DATA_API}/activity?${params.toString()}`);
  return unwrapList(data);
}

/** Currently open positions for a wallet. */
export async function fetchPositions(address: string, limit = 500): Promise<any[]> {
  const params = new URLSearchParams({
    user: address,
    limit: String(Math.min(limit, 500)),
  });
  const data = await getJson(`${DATA_API}/positions?${params.toString()}`);
  return unwrapList(data);
}

const GAMMA_API = "https://gamma-api.polymarket.com";

const SPORTS_LEAGUES = new Set([
  "epl",
  "mex",
  "nfl",
  "nba",
  "mlb",
  "nhl",
  "ucl",
  "mls",
  "lal",
  "bun",
  "sea",
  "fl1",
  "ere",
  "por",
  "tur",
  "spl",
  "dfb",
  "cof",
  "uef",
  "wta",
  "atp",
  "cs2",
  "lol",
  "val",
]);

const SPORTS_EVENT_SLUG =
  /^((?:epl|mex|nfl|nba|mlb|nhl|ucl|mls|lal|bun|sea|fl1|ere|por|tur|spl|dfb|cof|uef|wta|atp|cs2|lol|val)-.+-\d{4}-\d{2}-\d{2})/;

/** Build a browser URL from a Polymarket event or market slug. */
export function buildPolymarketUrlFromSlug(slug?: string | null): string | null {
  if (!slug) return null;
  const clean = slug.trim();
  if (!clean) return null;

  const prefix = clean.split("-")[0]?.toLowerCase();
  if (prefix && SPORTS_LEAGUES.has(prefix)) {
    const eventMatch = clean.match(SPORTS_EVENT_SLUG);
    const eventSlug = eventMatch ? eventMatch[1] : clean;
    return `https://polymarket.com/sports/${prefix}/${eventSlug}`;
  }

  return `https://polymarket.com/event/${clean}`;
}

/** Resolve slug + URL via Gamma search (title and/or condition id). */
export async function resolvePolymarketLink(opts: {
  marketTitle?: string;
  conditionId?: string;
  marketSlug?: string;
}): Promise<{ url: string | null; slug: string | null; eventSlug: string | null }> {
  const fromSlug = buildPolymarketUrlFromSlug(opts.marketSlug);
  if (fromSlug) {
    return { url: fromSlug, slug: opts.marketSlug || null, eventSlug: opts.marketSlug || null };
  }

  const query = opts.marketTitle || (opts.conditionId && !opts.conditionId.startsWith("0x") ? opts.conditionId : null);
  if (!query && !opts.marketSlug) return { url: null, slug: null, eventSlug: null };

  try {
    const params = new URLSearchParams({ q: query });
    const data = await getJson(`${GAMMA_API}/public-search?${params.toString()}`);
    const events = data?.events || [];

    for (const event of events) {
      const markets = event?.markets || [];
      for (const market of markets) {
        const cid = (market.conditionId || market.condition_id || "").toLowerCase();
        if (opts.conditionId && cid === opts.conditionId.toLowerCase()) {
          const url = buildPolymarketUrlFromGamma(event, market);
          return {
            url,
            slug: market.slug || event.slug || null,
            eventSlug: event.slug || null,
          };
        }
      }
    }

    if (opts.marketTitle) {
      const titleLower = opts.marketTitle.toLowerCase();
      for (const event of events) {
        const markets = event?.markets || [];
        const market = markets.find(
          (m: any) =>
            (m.question || "").toLowerCase() === titleLower ||
            (m.question || "").toLowerCase().includes(titleLower) ||
            titleLower.includes((m.question || "").toLowerCase())
        );
        if (market) {
          const url = buildPolymarketUrlFromGamma(event, market);
          return {
            url,
            slug: market.slug || event.slug || null,
            eventSlug: event.slug || null,
          };
        }
        if ((event.title || "").toLowerCase().includes(titleLower.split("?")[0].trim())) {
          const url = buildPolymarketUrlFromGamma(event);
          return { url, slug: event.slug || null, eventSlug: event.slug || null };
        }
      }
    }

    if (events[0]) {
      const url = buildPolymarketUrlFromGamma(events[0]);
      return {
        url,
        slug: events[0].slug || null,
        eventSlug: events[0].slug || null,
      };
    }
  } catch {
    /* fall through */
  }

  return { url: null, slug: null, eventSlug: null };
}

function buildPolymarketUrlFromGamma(event: any, market?: any): string | null {
  if (event?.slug) return buildPolymarketUrlFromSlug(event.slug);
  if (market?.slug) return buildPolymarketUrlFromSlug(market.slug);
  return null;
}

/** Fetch a single market record by slug (reliable Gamma endpoint). */
export async function fetchMarketBySlug(slug: string): Promise<any | null> {
  if (!slug) return null;
  try {
    return await getJson(`${GAMMA_API}/markets/slug/${encodeURIComponent(slug)}`);
  } catch {
    return null;
  }
}

function parseJsonArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseMarketOutcomes(market: any): { labels: string[]; prices: number[] } {
  const labels = parseJsonArray(market?.outcomes).map((x) => String(x));
  const prices = parseJsonArray(market?.outcomePrices).map((x) => Number(x));
  return { labels, prices };
}

function outcomePriceFromMarket(market: any, outcomeIndex: number): number | null {
  const { prices } = parseMarketOutcomes(market);
  if (prices[outcomeIndex] == null || !Number.isFinite(prices[outcomeIndex])) return null;
  return prices[outcomeIndex];
}

function conditionIdsMatch(market: any, conditionId: string): boolean {
  const cid = (market?.conditionId || market?.condition_id || "").toLowerCase();
  return !!conditionId && cid === conditionId.toLowerCase();
}

/** Official Gamma market for a condition id. Never uses fuzzy title search. */
export async function fetchMarketByConditionId(conditionId: string): Promise<any | null> {
  if (!conditionId) return null;
  try {
    const data = await getJson(
      `${GAMMA_API}/markets?condition_id=${encodeURIComponent(conditionId)}&limit=25`
    );
    const list = Array.isArray(data) ? data : [];
    return list.find((m: any) => conditionIdsMatch(m, conditionId)) || null;
  } catch {
    return null;
  }
}

/** Official market record: condition id first, slug only if the condition id matches. */
export async function fetchOfficialMarket(
  conditionId: string,
  marketSlug?: string | null
): Promise<any | null> {
  if (!conditionId) return null;
  const byId = await fetchMarketByConditionId(conditionId);
  if (byId) return byId;

  if (marketSlug) {
    const bySlug = await fetchMarketBySlug(marketSlug);
    if (bySlug && conditionIdsMatch(bySlug, conditionId)) return bySlug;
  }
  return null;
}

/** True only when Polymarket has actually settled this market. */
export function isOfficiallyResolved(market: any): boolean {
  if (!market) return false;
  const closed = market.closed === true || market.umaResolutionStatus === "resolved";
  if (!closed) return false;
  const { prices } = parseMarketOutcomes(market);
  return prices.some((p) => Number.isFinite(p) && (p >= 0.95 || p <= 0.05));
}

export function resolutionFromOfficialMarket(
  market: any,
  outcomeIndex: number
): { status: "open" | "won" | "lost"; exit_price?: number; exit_at?: string } {
  if (!isOfficiallyResolved(market)) return { status: "open" };
  const price = outcomePriceFromMarket(market, outcomeIndex);
  if (price == null) return { status: "open" };
  const exitAt = market.closedTime || market.umaEndDate || new Date().toISOString();
  if (price >= 0.95) return { status: "won", exit_price: 1, exit_at: exitAt };
  if (price <= 0.05) return { status: "lost", exit_price: 0, exit_at: exitAt };
  return { status: "open" };
}

/** Current mid price (0-1) for a market outcome via the official Gamma record only. */
export async function fetchOutcomePrice(
  conditionId: string,
  outcomeIndex: number,
  marketSlug?: string | null,
  _marketTitle?: string | null
): Promise<number | null> {
  const market = await fetchOfficialMarket(conditionId, marketSlug);
  if (!market) return null;
  return outcomePriceFromMarket(market, outcomeIndex);
}

/** Positions with zero value are stale/resolved — exclude from open exposure totals. */
export function isActiveOpenPosition(p: any): boolean {
  const value = Number(p.currentValue ?? p.current_value_usd ?? 0);
  if (value <= 0.01) return false;
  if (p.redeemable) return false;
  return true;
}

export function aggregateOpenPositions(positions: any[]) {
  const active = positions.filter(isActiveOpenPosition);
  return {
    count: active.length,
    valueUsd: active.reduce((s, p) => s + Number(p.currentValue ?? p.current_value_usd ?? 0), 0),
    unrealizedPnlUsd: active.reduce((s, p) => s + Number(p.cashPnl ?? p.cash_pnl_usd ?? 0), 0),
  };
}

function parseClobTokenIds(market: any): string[] {
  const raw = market?.clobTokenIds;
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Resolve CLOB outcome token id for price-history lookups. */
export async function fetchClobTokenId(
  conditionId: string,
  outcomeIndex: number,
  marketSlug?: string | null,
  _marketTitle?: string | null
): Promise<string | null> {
  try {
    const market = await fetchOfficialMarket(conditionId, marketSlug);
    const tokens = parseClobTokenIds(market);
    if (tokens[outcomeIndex]) return tokens[outcomeIndex];
  } catch {
    /* fall through */
  }
  return null;
}

/** Historical mid price nearest to a unix-ms timestamp (CLOB prices-history). */
export async function fetchPriceAtTime(tokenId: string, targetMs: number): Promise<number | null> {
  if (!tokenId) return null;
  try {
    const targetSec = Math.floor(targetMs / 1000);
    const params = new URLSearchParams({
      market: tokenId,
      startTs: String(Math.max(0, targetSec - 7200)),
      endTs: String(targetSec + 7200),
      fidelity: "1",
    });
    const data = await getJson(`${CLOB_API}/prices-history?${params.toString()}`);
    const history: Array<{ t: number; p: number }> = data?.history || [];
    if (!history.length) return null;

    let best = history[0];
    let bestDiff = Math.abs(best.t - targetSec);
    for (const pt of history) {
      const diff = Math.abs(pt.t - targetSec);
      if (diff < bestDiff) {
        best = pt;
        bestDiff = diff;
      }
    }
    return best?.p != null ? Number(best.p) : null;
  } catch {
    return null;
  }
}

/** Entry price at signal + delay: CLOB history when available, else skilled VWAP fallback. */
export async function resolveDelayedEntryPrice(
  cluster: {
    last_buy_at: string;
    vwap_entry_price: number;
    condition_id: string;
    outcome_index?: number;
    market_slug?: string;
    market_title?: string;
  },
  delaySec: number,
  slippage: number
): Promise<number> {
  const signalMs = new Date(cluster.last_buy_at).getTime();
  const entryMs = signalMs + delaySec * 1000;
  const outcomeIndex = cluster.outcome_index ?? 0;

  const tokenId = await fetchClobTokenId(
    cluster.condition_id,
    outcomeIndex,
    cluster.market_slug,
    cluster.market_title
  );
  let price = tokenId ? await fetchPriceAtTime(tokenId, entryMs) : null;
  if (price == null || !Number.isFinite(price)) {
    price = cluster.vwap_entry_price;
  }

  return Math.min(0.99, Math.max(0.01, price + slippage));
}

function activityDedupeKey(address: string, a: any): string {
  return [
    address,
    a.transactionHash || "",
    a.asset || "",
    a.outcomeIndex ?? "",
    a.side || "",
    a.timestamp ?? "",
    a.size ?? "",
  ].join("|");
}

/**
 * Fetches fresh activity + positions + leaderboard stats for a tracked wallet,
 * stores/updates the corresponding entities, and returns the updated TrackedWallet.
 * Activity rows are appended (deduped); positions are replaced wholesale each sync
 * since they represent current state, not history.
 */
export async function syncWalletRecord(base44: any, wallet: any): Promise<any> {
  const address = normalizeAddress(wallet.address);

  const [leaderboard, activities, positions] = await Promise.all([
    fetchLeaderboardStats(address).catch(() => null),
    fetchActivity(address),
    fetchPositions(address),
  ]);

  const existing = await base44.entities.WalletActivity.filter(
    { wallet_address: address },
    null,
    5000,
    0,
    ["dedupe_key"]
  );
  const existingKeys = new Set(existing.map((e: any) => e.dedupe_key));

  const newRows: any[] = [];
  for (const a of activities) {
    const key = activityDedupeKey(address, a);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    newRows.push({
      wallet_address: address,
      event_type: a.type,
      side: a.side || undefined,
      market_title: a.title,
      market_slug: a.slug,
      condition_id: a.conditionId,
      outcome: a.outcome,
      outcome_index: a.outcomeIndex,
      price: a.price,
      size: a.size,
      usdc_size: a.usdcSize,
      occurred_at: toIso(a.timestamp),
      transaction_hash: a.transactionHash,
      dedupe_key: key,
    });
  }
  if (newRows.length) {
    await base44.entities.WalletActivity.bulkCreate(newRows);
  }

  await base44.entities.WalletPosition.deleteMany({ wallet_address: address });
  if (positions.length) {
    await base44.entities.WalletPosition.bulkCreate(
      positions.map((p: any) => ({
        wallet_address: address,
        condition_id: p.conditionId,
        market_title: p.title,
        market_slug: p.slug,
        outcome: p.outcome,
        outcome_index: p.outcomeIndex,
        size: p.size,
        avg_price: p.avgPrice,
        current_price: p.curPrice,
        initial_value_usd: p.initialValue,
        current_value_usd: p.currentValue,
        cash_pnl_usd: p.cashPnl,
        percent_pnl: p.percentPnl,
        redeemable: !!p.redeemable,
      }))
    );
  }

  const distinctMarkets = new Set(activities.map((a) => a.conditionId).filter(Boolean)).size;
  const timestamps = activities.map((a) => a.timestamp).filter((t) => typeof t === "number");
  const firstAt = timestamps.length ? toIso(Math.min(...timestamps)) : wallet.first_synced_activity_at;
  const lastAt = timestamps.length ? toIso(Math.max(...timestamps)) : wallet.last_synced_activity_at;

  const openAgg = aggregateOpenPositions(positions);

  const updates = {
    label: wallet.label || leaderboard?.userName || wallet.label,
    last_synced_at: new Date().toISOString(),
    last_sync_status: "success",
    last_sync_error: "",
    all_time_pnl_usd: leaderboard?.pnl ?? wallet.all_time_pnl_usd ?? 0,
    all_time_volume_usd: leaderboard?.vol ?? wallet.all_time_volume_usd ?? 0,
    activity_count_synced: existingKeys.size,
    distinct_markets_synced: distinctMarkets,
    open_positions_count: openAgg.count,
    open_positions_value_usd: openAgg.valueUsd,
    open_positions_unrealized_pnl_usd: openAgg.unrealizedPnlUsd,
    first_synced_activity_at: firstAt,
    last_synced_activity_at: lastAt,
  };

  return base44.entities.TrackedWallet.update(wallet.id, updates);
}
