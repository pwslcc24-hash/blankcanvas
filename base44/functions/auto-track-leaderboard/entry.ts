import { createClientFromRequest } from "npm:@base44/sdk";
import { fetchLeaderboardPage, normalizeAddress } from "../../shared/polymarket.ts";

// Casts a wide net across Polymarket's leaderboard so no one has to manually
// click "Track" on every wallet. Pulls several slices (all-time PnL, all-time
// volume, and recent-month PnL/volume so newly hot wallets aren't missed),
// dedupes against wallets already tracked, and creates the rest as tracked.
// It never places trades or judges anyone — the scoring engine (score-wallets)
// decides who's actually good once enough history has synced. Called by any
// logged-in user, including the daily GitHub Actions cron.
const SLICES: Array<{ category: string; timePeriod: string; orderBy: string }> = [
  { category: "OVERALL", timePeriod: "ALL", orderBy: "PNL" },
  { category: "OVERALL", timePeriod: "ALL", orderBy: "VOL" },
  { category: "OVERALL", timePeriod: "MONTH", orderBy: "PNL" },
  { category: "OVERALL", timePeriod: "MONTH", orderBy: "VOL" },
];

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const limitPerSlice = Math.min(Number(body?.limitPerSlice) || 100, 200);

  const existing = await base44.entities.TrackedWallet.list(null, 5000, 0, ["address"]);
  const known = new Set(existing.map((w: any) => w.address));

  const candidates = new Map<string, { label?: string; source: "leaderboard_pnl" | "leaderboard_vol" }>();

  for (const slice of SLICES) {
    try {
      const entries = await fetchLeaderboardPage({ ...slice, limit: limitPerSlice });
      for (const entry of entries) {
        const address = normalizeAddress(entry.proxyWallet || entry.wallet || "");
        if (!address || known.has(address) || candidates.has(address)) continue;
        candidates.set(address, {
          label: entry.userName || entry.user_name || undefined,
          source: slice.orderBy === "VOL" ? "leaderboard_vol" : "leaderboard_pnl",
        });
      }
    } catch (err) {
      console.error(`leaderboard slice failed (${JSON.stringify(slice)}):`, err);
    }
  }

  const toCreate = Array.from(candidates.entries()).map(([address, meta]) => ({
    address,
    label: meta.label,
    source: meta.source,
    is_active: true,
  }));

  if (toCreate.length) {
    await base44.entities.TrackedWallet.bulkCreate(toCreate);
  }

  return Response.json({
    considered: candidates.size + known.size,
    already_tracked: known.size,
    newly_tracked: toCreate.length,
  });
}
