// Shared helpers for talking to Polymarket's public Data API
// (https://data-api.polymarket.com). No API key required — these are
// read-only, publicly documented endpoints.

export const DATA_API = "https://data-api.polymarket.com";

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

  const query = opts.marketTitle || opts.conditionId;
  if (!query) return { url: null, slug: null, eventSlug: null };

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

/** Best-effort current mid price (0-1) for a market outcome via Gamma API. */
export async function fetchOutcomePrice(
  conditionId: string,
  outcomeIndex: number
): Promise<number | null> {
  if (!conditionId) return null;
  try {
    const params = new URLSearchParams({ condition_ids: conditionId });
    const markets = await getJson(`${GAMMA_API}/markets?${params.toString()}`);
    const list = Array.isArray(markets) ? markets : markets?.data || [];
    const market = list[0];
    if (!market) return null;

    const tokens = market.tokens || market.clobTokenIds || [];
    if (Array.isArray(tokens) && tokens.length) {
      const token = tokens.find(
        (t: any) =>
          t.outcomeIndex === outcomeIndex ||
          t.outcome_index === outcomeIndex ||
          Number(t.index) === outcomeIndex
      );
      if (token?.price != null) return Number(token.price);
    }

    // Gamma sometimes exposes outcomePrices as parallel arrays
    const prices = market.outcomePrices;
    if (prices != null) {
      const parsed = typeof prices === "string" ? JSON.parse(prices) : prices;
      if (Array.isArray(parsed) && parsed[outcomeIndex] != null) {
        return Number(parsed[outcomeIndex]);
      }
    }
    return null;
  } catch {
    return null;
  }
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

  const openValue = positions.reduce((sum: number, p: any) => sum + (p.currentValue || 0), 0);
  const openPnl = positions.reduce((sum: number, p: any) => sum + (p.cashPnl || 0), 0);

  const updates = {
    label: wallet.label || leaderboard?.userName || wallet.label,
    last_synced_at: new Date().toISOString(),
    last_sync_status: "success",
    last_sync_error: "",
    all_time_pnl_usd: leaderboard?.pnl ?? wallet.all_time_pnl_usd ?? 0,
    all_time_volume_usd: leaderboard?.vol ?? wallet.all_time_volume_usd ?? 0,
    activity_count_synced: existingKeys.size,
    distinct_markets_synced: distinctMarkets,
    open_positions_count: positions.length,
    open_positions_value_usd: openValue,
    open_positions_unrealized_pnl_usd: openPnl,
    first_synced_activity_at: firstAt,
    last_synced_activity_at: lastAt,
  };

  return base44.entities.TrackedWallet.update(wallet.id, updates);
}
