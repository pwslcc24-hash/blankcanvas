import { createClientFromRequest } from "npm:@base44/sdk";
import { normalizeAddress, syncWalletRecord } from "../../shared/polymarket.ts";

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);

  const user = await base44.auth.me().catch(() => null);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { walletId, address } = body || {};

  let wallet: any = null;
  if (walletId) {
    wallet = await base44.entities.TrackedWallet.get(walletId).catch(() => null);
  } else if (address) {
    const matches = await base44.entities.TrackedWallet.filter({
      address: normalizeAddress(address),
    });
    wallet = matches[0] || null;
  }

  if (!wallet) {
    return Response.json({ error: "Tracked wallet not found" }, { status: 404 });
  }

  try {
    const updated = await syncWalletRecord(base44, wallet);
    return Response.json({ success: true, wallet: updated });
  } catch (err: any) {
    await base44.entities.TrackedWallet.update(wallet.id, {
      last_sync_status: "error",
      last_sync_error: String(err?.message || err),
      last_synced_at: new Date().toISOString(),
    });
    return Response.json({ error: String(err?.message || err) }, { status: 502 });
  }
}
