import { createClientFromRequest } from "npm:@base44/sdk";
import {
  classifySignalQuality,
  detectConsensusGroups,
  isFastMarket,
  isSkilledForConsensus,
} from "../../shared/consensus.ts";
import { fetchOutcomePrice } from "../../shared/polymarket.ts";
import { withRetry } from "../../shared/retry.ts";

const DEFAULT_WINDOW_HOURS = 6;
const ACTIVITY_PER_WALLET = 40;
const WALLET_BATCH = 8;

async function fetchSkilledBuys(base44: any, wallets: any[]): Promise<any[]> {
  const skilled = wallets.filter(isSkilledForConsensus);
  const buys: any[] = [];

  for (let i = 0; i < skilled.length; i += WALLET_BATCH) {
    const batch = skilled.slice(i, i + WALLET_BATCH);
    const chunks = await Promise.all(
      batch.map(async (wallet) => {
        try {
          const rows = await withRetry(() =>
            base44.entities.WalletActivity.filter(
              { wallet_address: wallet.address, event_type: "TRADE", side: "BUY" },
              "-occurred_at",
              ACTIVITY_PER_WALLET
            )
          );
          return rows;
        } catch {
          return [];
        }
      })
    );
    for (const rows of chunks) buys.push(...rows);
  }

  return buys;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const windowHours = Math.min(Math.max(Number(body?.windowHours) || DEFAULT_WINDOW_HOURS, 1), 24);
    const minWallets = Math.min(Math.max(Number(body?.minWallets) || 2, 2), 10);
    const now = new Date();

    const wallets = await base44.entities.TrackedWallet.filter({ is_active: true });
    const walletsByAddress = new Map(wallets.map((w: any) => [w.address, w]));
    const skilledCount = wallets.filter(isSkilledForConsensus).length;

    const recentBuys = await fetchSkilledBuys(base44, wallets);

    const groups = detectConsensusGroups(recentBuys, walletsByAddress, {
      windowHours,
      minWallets,
      now,
    });

    let created = 0;
    let updated = 0;
    const results: any[] = [];

    for (const group of groups) {
      const fastMarket = isFastMarket(group.market_title, group.market_slug);
      let currentPrice = await fetchOutcomePrice(group.condition_id, group.outcome_index ?? 0);

      // Gamma API misses some sports/live markets — fall back to synced position prices
      if (currentPrice == null) {
        try {
          const positions = await base44.entities.WalletPosition.filter({
            condition_id: group.condition_id,
          });
          const priced = positions.filter(
            (p: any) =>
              p.outcome_index === group.outcome_index &&
              p.current_price != null &&
              Number.isFinite(Number(p.current_price))
          );
          if (priced.length) {
            currentPrice =
              priced.reduce((s: number, p: any) => s + Number(p.current_price), 0) / priced.length;
          }
        } catch {
          /* ignore */
        }
      }

      const priceDrift =
        currentPrice != null && group.vwap_entry_price
          ? currentPrice - group.vwap_entry_price
          : null;

      const { quality, block_reason } = classifySignalQuality({
        fastMarket,
        priceDrift,
        maxPriceDriftStrong: 0.02,
        maxPriceDriftCaution: 0.05,
      });

      const row = {
        signal_key: group.signal_key,
        condition_id: group.condition_id,
        market_title: group.market_title,
        market_slug: group.market_slug,
        outcome: group.outcome,
        outcome_index: group.outcome_index,
        detected_at: now.toISOString(),
        first_buy_at: group.first_buy_at,
        last_buy_at: group.last_buy_at,
        window_hours: windowHours,
        wallet_count: group.wallet_count,
        participants_json: JSON.stringify(group.participants),
        vwap_entry_price: Math.round(group.vwap_entry_price * 10000) / 10000,
        total_usdc: Math.round(group.total_usdc * 100) / 100,
        current_price: currentPrice,
        price_drift: priceDrift != null ? Math.round(priceDrift * 10000) / 10000 : undefined,
        quality,
        status: "active",
        block_reason,
      };

      const existing = await base44.entities.ConsensusAlert.filter({ signal_key: group.signal_key });
      if (existing.length) {
        await base44.entities.ConsensusAlert.update(existing[0].id, {
          ...row,
          status: existing[0].status === "dismissed" ? "dismissed" : "active",
        });
        updated += 1;
      } else {
        await base44.entities.ConsensusAlert.create(row);
        created += 1;
      }

      results.push({
        signal_key: group.signal_key,
        market_title: group.market_title,
        outcome: group.outcome,
        wallet_count: group.wallet_count,
        quality,
        vwap_entry_price: row.vwap_entry_price,
        current_price: currentPrice,
        price_drift: row.price_drift,
      });
    }

    const expireBefore = new Date(now.getTime() - windowHours * 2 * 3600 * 1000).toISOString();
    const stale = await base44.entities.ConsensusAlert.filter({ status: "active" });
    let expired = 0;
    for (const alert of stale) {
      if (alert.detected_at && alert.detected_at < expireBefore) {
        await base44.entities.ConsensusAlert.update(alert.id, { status: "expired" });
        expired += 1;
      }
    }

    return Response.json({
      windowHours,
      minWallets,
      skilledWallets: skilledCount,
      buysSampled: recentBuys.length,
      groupsFound: groups.length,
      created,
      updated,
      expired,
      results,
    });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
