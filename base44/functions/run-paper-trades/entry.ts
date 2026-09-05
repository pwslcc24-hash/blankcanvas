import { createClientFromRequest } from "npm:@base44/sdk";
import { alertMatchesStrategy, STRATEGY_PRESETS } from "../../shared/strategies.ts";
import { isSkilledForConsensus } from "../../shared/consensus.ts";
import { resolveTradeOutcome, simulatePaperTrade } from "../../shared/paper-trading.ts";
import { withRetry } from "../../shared/retry.ts";

const WALLET_BATCH = 8;

async function fetchRedeems(base44: any): Promise<any[]> {
  const wallets = await base44.entities.TrackedWallet.filter({ is_active: true });
  const skilled = wallets.filter(isSkilledForConsensus);
  const redeems: any[] = [];
  for (let i = 0; i < skilled.length; i += WALLET_BATCH) {
    const batch = skilled.slice(i, i + WALLET_BATCH);
    const chunks = await Promise.all(
      batch.map(async (wallet: any) => {
        try {
          return await withRetry(() =>
            base44.entities.WalletActivity.filter(
              { wallet_address: wallet.address, event_type: "REDEEM" },
              "-occurred_at",
              40
            )
          );
        } catch {
          return [];
        }
      })
    );
    for (const rows of chunks) redeems.push(...rows);
  }
  return redeems;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

    let redeems: any[] = [];
    try {
      redeems = await fetchRedeems(base44);
    } catch {
      redeems = [];
    }

    const alerts = await base44.entities.ConsensusAlert.filter({ status: "active" });
    const recentAlerts = alerts.filter((a: any) => a.detected_at >= since);

    let entered = 0;
    let resolved = 0;

    for (const preset of STRATEGY_PRESETS) {
      const strategyRows = await base44.entities.PaperStrategy.filter({
        strategy_id: preset.strategy_id,
      });
      if (strategyRows.length && strategyRows[0].is_active === false) continue;

      for (const alert of recentAlerts) {
        if (!alertMatchesStrategy(alert, preset.params)) continue;

        const tradeKey = `${preset.strategy_id}|${alert.signal_key}`;
        const existing = await base44.entities.PaperTrade.filter({ trade_key: tradeKey });
        if (existing.length) continue;

        const cluster = {
          signal_key: alert.signal_key,
          condition_id: alert.condition_id,
          market_title: alert.market_title,
          market_slug: alert.market_slug,
          outcome: alert.outcome,
          outcome_index: alert.outcome_index,
          first_buy_at: alert.first_buy_at || alert.detected_at,
          last_buy_at: alert.last_buy_at || alert.detected_at,
          wallet_count: alert.wallet_count,
          participants: [],
          vwap_entry_price: alert.vwap_entry_price,
          total_usdc: alert.total_usdc,
        };

        const entryMs =
          new Date(cluster.last_buy_at).getTime() + preset.params.delaySec * 1000;
        const resolution = resolveTradeOutcome(
          cluster.condition_id,
          cluster.outcome_index ?? 0,
          entryMs,
          redeems
        );

        const trade = simulatePaperTrade(cluster, preset.strategy_id, preset.params, resolution);
        await base44.entities.PaperTrade.create({
          ...trade,
          strategy_id: preset.strategy_id,
          is_backtest: false,
        });
        entered += 1;
      }

      // Resolve open forward trades for this strategy
      const openTrades = await base44.entities.PaperTrade.filter({
        strategy_id: preset.strategy_id,
        status: "open",
        is_backtest: false,
      });
      for (const t of openTrades) {
        const entryMs = new Date(t.entry_at).getTime();
        const resolution = resolveTradeOutcome(
          t.condition_id,
          t.outcome_index ?? 0,
          entryMs,
          redeems
        );
        if (resolution.status === "open") continue;

        const exitPrice = resolution.exit_price ?? 0;
        const proceeds = (t.shares || 0) * exitPrice;
        const pnl = Math.round((proceeds - (t.stake_usd || 0)) * 100) / 100;

        await base44.entities.PaperTrade.update(t.id, {
          status: resolution.status,
          exit_at: resolution.exit_at,
          exit_price: exitPrice,
          pnl_usd: pnl,
        });
        resolved += 1;
      }
    }

    return Response.json({
      alertsChecked: recentAlerts.length,
      entered,
      resolved,
    });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
