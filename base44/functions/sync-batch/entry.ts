import { createClientFromRequest } from "npm:@base44/sdk";
import { syncWalletRecord } from "../../shared/polymarket.ts";
import { withRetry } from "../../shared/retry.ts";

// Processes a bounded batch of the least-recently-synced active wallets per
// call, with limited concurrency, so a large tracked-wallet list never risks
// a single invocation running past the platform's execution window. The
// caller (dashboard button, or the GitHub Actions cron loop) invokes this
// repeatedly until `remaining` is 0.
//
// Named "sync-batch" rather than "sync-all-wallets" because the original
// function name got stuck on Base44's platform (requests to it hung forever
// with zero logs, even though this identical code works fine here) — see
// git history for the full investigation.
//
// The caller should pass the same `runStartedAt` (ISO timestamp, captured
// once before the first call) on every call in a loop. That lets `remaining`
// be computed as "wallets not yet touched during this run" instead of a
// static totalActive-minus-batchSize number that never actually decreases.
const DEFAULT_BATCH_SIZE = 10;
const CONCURRENCY = 3;

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runNext(): Promise<void> {
    const i = next++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body?.batchSize) || DEFAULT_BATCH_SIZE, 1), 50);
    const runStartedAt = body?.runStartedAt ? new Date(body.runStartedAt).getTime() : null;

    const allActive = await base44.entities.TrackedWallet.filter({ is_active: true });
    const candidates = runStartedAt
      ? allActive.filter((w: any) => {
          const t = w.last_synced_at ? new Date(w.last_synced_at).getTime() : -1;
          return t < runStartedAt;
        })
      : allActive;
    candidates.sort((a: any, b: any) => {
      const at = a.last_synced_at ? new Date(a.last_synced_at).getTime() : -1;
      const bt = b.last_synced_at ? new Date(b.last_synced_at).getTime() : -1;
      return at - bt; // never-synced (-1) first, then oldest sync first
    });

    const batch = candidates.slice(0, batchSize);
    const remaining = Math.max(candidates.length - batch.length, 0);

    const results = await runWithConcurrency(batch, CONCURRENCY, async (wallet: any) => {
      try {
        const updated = await withRetry(() => syncWalletRecord(base44, wallet));
        return { id: wallet.id, address: wallet.address, success: true, wallet: updated };
      } catch (err: any) {
        const message = String(err?.message || err);
        await base44.entities.TrackedWallet.update(wallet.id, {
          last_sync_status: "error",
          last_sync_error: message,
          last_synced_at: new Date().toISOString(),
        }).catch(() => {});
        return { id: wallet.id, address: wallet.address, success: false, error: message };
      }
    });

    return Response.json({
      requestedBatchSize: batchSize,
      totalActive: allActive.length,
      batchSize: batch.length,
      remaining,
      synced: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
