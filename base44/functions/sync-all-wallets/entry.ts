import { resolveClient } from "../../shared/auth.ts";
import { syncWalletRecord } from "../../shared/polymarket.ts";

// Sequential with a small delay between wallets to stay polite to the public
// Polymarket Data API. Callable two ways:
//  - by a logged-in user (the "Sync all" button in the dashboard)
//  - by an external scheduler (GitHub Actions cron) presenting the SYNC_SECRET
//    header, since Base44 has no built-in cron.
const DELAY_MS = 250;

export default async function (req: Request): Promise<Response> {
  const { client, mode } = await resolveClient(req);
  if (mode === "unauthorized" || !client) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const wallets = await client.entities.TrackedWallet.filter({ is_active: true });

  const results: any[] = [];
  for (const wallet of wallets) {
    try {
      const updated = await syncWalletRecord(client, wallet);
      results.push({ id: wallet.id, address: wallet.address, success: true, wallet: updated });
    } catch (err: any) {
      const message = String(err?.message || err);
      await client.entities.TrackedWallet.update(wallet.id, {
        last_sync_status: "error",
        last_sync_error: message,
        last_synced_at: new Date().toISOString(),
      });
      results.push({ id: wallet.id, address: wallet.address, success: false, error: message });
    }
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  return Response.json({
    mode,
    synced: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  });
}
