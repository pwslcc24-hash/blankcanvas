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

/** Sports: full market slug. Other markets need the event slug or a backend lookup. */
export function polymarketUrlFromSlug(slug, eventSlug) {
  const market = slug ? String(slug).trim() : "";
  const event = eventSlug ? String(eventSlug).trim() : "";
  const sportsSource = market || event;
  if (!sportsSource) return null;

  const prefix = sportsSource.split("-")[0]?.toLowerCase();
  if (prefix && SPORTS_LEAGUES.has(prefix)) {
    return `https://polymarket.com/sports/${prefix}/${market || event}`;
  }

  if (event) return `https://polymarket.com/event/${event}`;
  return null;
}

export function tradePolymarketUrlSync(trade, alerts, urlCache) {
  const key = trade.id || trade.trade_key;
  if (urlCache?.[key]) return urlCache[key];

  if (trade.market_slug) {
    const url = polymarketUrlFromSlug(trade.market_slug);
    if (url) return url;
  }

  const alert = findAlertForTrade(trade, alerts);
  if (alert?.market_slug) {
    const url = polymarketUrlFromSlug(alert.market_slug);
    if (url) return url;
  }

  return null;
}

export { findAlertForTrade };

export async function openTradePolymarketUrl(trade, alerts, urlCache, invokeResolve) {
  const key = trade.id || trade.trade_key;
  const cached = urlCache?.[key] || tradePolymarketUrlSync(trade, alerts, urlCache);
  if (cached) {
    window.open(cached, "_blank", "noopener,noreferrer");
    return cached;
  }

  const alert = findAlertForTrade(trade, alerts);
  const res = await invokeResolve({
    condition_id: trade.condition_id,
    market_slug: trade.market_slug || alert?.market_slug,
  });
  const url = res?.url || res?.data?.url;
  if (url) {
    window.open(url, "_blank", "noopener,noreferrer");
    return url;
  }
  return null;
}

function findAlertForTrade(trade, alerts) {
  const exact = alerts.find((a) => a.signal_key === trade.signal_key);
  if (exact) return exact;

  const signalMs = new Date(trade.signal_at || trade.entry_at).getTime();
  let best = null;
  let bestDiff = Infinity;

  for (const alert of alerts) {
    if (alert.condition_id !== trade.condition_id) continue;
    if (
      alert.outcome_index != null &&
      trade.outcome_index != null &&
      alert.outcome_index !== trade.outcome_index
    ) {
      continue;
    }
    const t = new Date(alert.last_buy_at || alert.detected_at).getTime();
    const diff = Math.abs(t - signalMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = alert;
    }
  }

  if (best && bestDiff <= 24 * 3600 * 1000) return best;
  return null;
}
