import { createClientFromRequest } from "npm:@base44/sdk";
import { computeWalletScore } from "../../shared/scoring.ts";
import { withRetry } from "../../shared/retry.ts";

// Scores a bounded batch of active wallets per call (same pagination pattern
// as sync-batch) so a large tracked-wallet list can't run a single
// invocation past the platform's execution window.
//
// Named "score-batch" rather than "score-wallets" because the original
// function name got stuck on Base44's platform (kept ignoring batchSize and
// running unbounded, same symptom as the sync-all-wallets issue).
//
// The caller should pass the same `runStartedAt` (ISO timestamp, captured
// once before the first call) on every call in a loop, so `remaining`
// reflects wallets not yet scored during this run rather than a static
// number that never decreases.
const DEFAULT_BATCH_SIZE = 40;

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body?.batchSize) || DEFAULT_BATCH_SIZE, 1), 200);
    const runStartedAt = body?.runStartedAt ? new Date(body.runStartedAt).getTime() : null;

    const allActive = await base44.entities.TrackedWallet.filter({ is_active: true });
    const candidates = runStartedAt
      ? allActive.filter((w: any) => {
          const t = w.last_scored_at ? new Date(w.last_scored_at).getTime() : -1;
          return t < runStartedAt;
        })
      : allActive;
    candidates.sort((a: any, b: any) => {
      const at = a.last_scored_at ? new Date(a.last_scored_at).getTime() : -1;
      const bt = b.last_scored_at ? new Date(b.last_scored_at).getTime() : -1;
      return at - bt;
    });

    const batch = candidates.slice(0, batchSize);
    const remaining = Math.max(candidates.length - batch.length, 0);
    const now = new Date().toISOString();
    const results: any[] = [];

    for (const wallet of batch) {
      try {
        await withRetry(async () => {
          const [activities, positions] = await Promise.all([
            base44.entities.WalletActivity.filter({ wallet_address: wallet.address }, null, 5000),
            base44.entities.WalletPosition.filter({ wallet_address: wallet.address }, null, 1000),
          ]);

          const result = computeWalletScore(wallet, activities, positions);

          const scoreRow = {
            wallet_address: wallet.address,
            computed_at: now,
            ...result,
          };
          const existing = await base44.entities.WalletScore.filter({
            wallet_address: wallet.address,
          });
          if (existing.length) {
            await base44.entities.WalletScore.update(existing[0].id, scoreRow);
          } else {
            await base44.entities.WalletScore.create(scoreRow);
          }

          await base44.entities.TrackedWallet.update(wallet.id, {
            skill_score: result.score,
            skill_grade: result.grade,
            score_confidence: result.confidence,
            last_scored_at: now,
          });

          results.push({ address: wallet.address, success: true, score: result.score, grade: result.grade });
        });
      } catch (err: any) {
        results.push({ address: wallet.address, success: false, error: String(err?.message || err) });
      }
    }

    return Response.json({
      batchSize: batch.length,
      remaining,
      scored: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
