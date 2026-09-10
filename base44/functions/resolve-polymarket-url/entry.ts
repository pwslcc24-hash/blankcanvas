import { createClientFromRequest } from "npm:@base44/sdk";
import { buildPolymarketUrlFromSlug, resolvePolymarketLink } from "../../shared/polymarket.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const conditionId = body?.condition_id;
    const marketTitle = body?.market_title;
    let marketSlug = body?.market_slug;

    if (!marketSlug && conditionId) {
      const activity = await base44.entities.WalletActivity.filter(
        { condition_id: conditionId },
        "-occurred_at",
        1
      );
      if (activity[0]?.market_slug) marketSlug = activity[0].market_slug;
    }

    if (marketSlug) {
      const url = buildPolymarketUrlFromSlug(marketSlug);
      if (url) {
        return Response.json({ url, slug: marketSlug, source: "slug" });
      }
    }

    const resolved = await resolvePolymarketLink({
      marketTitle,
      conditionId,
      marketSlug,
    });

    return Response.json({
      url: resolved.url,
      slug: resolved.slug,
      event_slug: resolved.eventSlug,
      source: resolved.url ? "official" : "not_found",
    });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
