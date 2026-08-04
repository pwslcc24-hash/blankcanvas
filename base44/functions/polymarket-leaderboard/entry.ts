import { createClientFromRequest } from "npm:@base44/sdk";
import { fetchLeaderboardPage } from "../../shared/polymarket.ts";

// Discovery-only proxy for Polymarket's public leaderboard. Intentionally does
// not write any entities — a wallet only gets tracked (and synced) once the
// user explicitly adds it, so browsing the leaderboard never silently starts
// "copying" anyone.
export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);

  const user = await base44.auth.me().catch(() => null);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { category, timePeriod, orderBy, limit, offset } = body || {};

  try {
    const entries = await fetchLeaderboardPage({ category, timePeriod, orderBy, limit, offset });
    return Response.json({ entries });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 502 });
  }
}
