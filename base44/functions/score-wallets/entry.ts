import { resolveClient } from "../../shared/auth.ts";
import { computeWalletScore } from "../../shared/scoring.ts";

export default async function (req: Request): Promise<Response> {
  const { client, mode } = await resolveClient(req);
  if (mode === "unauthorized" || !client) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const wallets = await client.entities.TrackedWallet.filter({ is_active: true });
  const now = new Date().toISOString();
  const results: any[] = [];

  for (const wallet of wallets) {
    try {
      const [activities, positions] = await Promise.all([
        client.entities.WalletActivity.filter(
          { wallet_address: wallet.address },
          null,
          5000
        ),
        client.entities.WalletPosition.filter(
          { wallet_address: wallet.address },
          null,
          1000
        ),
      ]);

      const result = computeWalletScore(wallet, activities, positions);

      const scoreRow = {
        wallet_address: wallet.address,
        computed_at: now,
        ...result,
      };
      const existing = await client.entities.WalletScore.filter({
        wallet_address: wallet.address,
      });
      if (existing.length) {
        await client.entities.WalletScore.update(existing[0].id, scoreRow);
      } else {
        await client.entities.WalletScore.create(scoreRow);
      }

      await client.entities.TrackedWallet.update(wallet.id, {
        skill_score: result.score,
        skill_grade: result.grade,
        score_confidence: result.confidence,
        last_scored_at: now,
      });

      results.push({ address: wallet.address, success: true, score: result.score, grade: result.grade });
    } catch (err: any) {
      results.push({ address: wallet.address, success: false, error: String(err?.message || err) });
    }
  }

  return Response.json({
    scored: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  });
}
