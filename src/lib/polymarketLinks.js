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

export function polymarketUrlFromSlug(slug) {
  if (!slug) return null;
  const clean = String(slug).trim();
  if (!clean) return null;

  const prefix = clean.split("-")[0]?.toLowerCase();
  if (prefix && SPORTS_LEAGUES.has(prefix)) {
    const eventMatch = clean.match(SPORTS_EVENT_SLUG);
    const eventSlug = eventMatch ? eventMatch[1] : clean;
    return `https://polymarket.com/sports/${prefix}/${eventSlug}`;
  }

  return `https://polymarket.com/event/${clean}`;
}

export function tradePolymarketUrlSync(trade, alerts, urlCache) {
  const key = trade.id || trade.trade_key;
  if (urlCache?.[key]) return urlCache[key];

  if (trade.market_slug) return polymarketUrlFromSlug(trade.market_slug);

  const alert = findAlertForTrade(trade, alerts);
  if (alert?.market_slug) return polymarketUrlFromSlug(alert.market_slug);

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
