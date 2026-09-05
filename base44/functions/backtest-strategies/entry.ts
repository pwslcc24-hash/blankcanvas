import { createClientFromRequest } from "npm:@base44/sdk";
import { isSkilledForConsensus } from "../../shared/consensus.ts";
import { fetchOutcomePrice } from "../../shared/polymarket.ts";
import {
  aggregateStats,
  findHistoricalClusters,
  resolveTradeOutcome,
  simulatePaperTrade,
} from "../../shared/paper-trading.ts";
import { STRATEGY_PRESETS } from "../../shared/strategies.ts";
import { withRetry } from "../../shared/retry.ts";

const ACTIVITY_PER_WALLET = 120;
const WALLET_BATCH = 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
const MAX_GAMMA_LOOKUPS = 35;

async function fetchSkilledBuys(base44: any, wallets: any[]): Promise<any[]> {
  const skilled = wallets.filter(isSkilledForConsensus);
  const buys: any[] = [];
  for (let i = 0; i < skilled.length; i += WALLET_BATCH) {
    const batch = skilled.slice(i, i + WALLET_BATCH);
    const chunks = await Promise.all(
      batch.map(async (wallet) => {
        try {
          return await withRetry(() =>
            base44.entities.WalletActivity.filter(
              { wallet_address: wallet.address, event_type: "TRADE", side: "BUY" },
              "-occurred_at",
              ACTIVITY_PER_WALLET
            )
          );
        } catch {
          return [];
        }
      })
    );
    for (const rows of chunks) buys.push(...rows);
    if (i + WALLET_BATCH < skilled.length) await sleep(200);
  }
  return buys;
}

async function fetchSkilledRedeems(base44: any, wallets: any[]): Promise<any[]> {
  const skilled = wallets.filter(isSkilledForConsensus);
  const redeems: any[] = [];
  for (let i = 0; i < skilled.length; i += WALLET_BATCH) {
    const batch = skilled.slice(i, i + WALLET_BATCH);
    const chunks = await Promise.all(
      batch.map(async (wallet) => {
        try {
          return await withRetry(() =>
            base44.entities.WalletActivity.filter(
              { wallet_address: wallet.address, event_type: "REDEEM" },
              "-occurred_at",
              80
            )
          );
        } catch {
          return [];
        }
      })
    );
    for (const rows of chunks) redeems.push(...rows);
    if (i + WALLET_BATCH < skilled.length) await sleep(200);
  }
  return redeems;
}

async function resolveWithPriceFallback(
  conditionId: string,
  outcomeIndex: number,
  entryMs: number,
  allActivities: any[],
  priceCache: Map<string, number | null>,
  gammaBudget: { left: number },
  now: Date
) {
  let resolution = resolveTradeOutcome(conditionId, outcomeIndex, entryMs, allActivities);
  if (resolution.status !== "open") return resolution;

  const cacheKey = `${conditionId}|${outcomeIndex}`;
  if (!priceCache.has(cacheKey) && gammaBudget.left > 0) {
    gammaBudget.left -= 1;
    priceCache.set(cacheKey, await fetchOutcomePrice(conditionId, outcomeIndex));
  }
  const p = priceCache.get(cacheKey);
  if (p != null && p >= 0.95) {
    return { status: "won" as const, exit_price: 1, exit_at: now.toISOString() };
  }
  if (p != null && p <= 0.05) {
    return { status: "lost" as const, exit_price: 0, exit_at: now.toISOString() };
  }
  return resolution;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const full = body?.full === true || body?.full === "true";
    const offset = Math.max(Number(body?.offset) || 0, 0);
    const limit = full
      ? STRATEGY_PRESETS.length
      : Math.min(Math.max(Number(body?.limit) || 5, 1), 10);
    const now = new Date();

    for (const preset of STRATEGY_PRESETS) {
      const existing = await base44.entities.PaperStrategy.filter({
        strategy_id: preset.strategy_id,
      });
      if (!existing.length) {
        await base44.entities.PaperStrategy.create({
          strategy_id: preset.strategy_id,
          name: preset.name,
          params_json: JSON.stringify(preset.params),
          is_active: true,
        });
      }
    }

    const wallets = await base44.entities.TrackedWallet.filter({ is_active: true });
    const walletsByAddress = new Map(wallets.map((w: any) => [w.address, w]));
    const [buys, redeems] = await Promise.all([
      fetchSkilledBuys(base44, wallets),
      fetchSkilledRedeems(base44, wallets),
    ]);
    const allActivities = [...buys, ...redeems];

    const existingTrades = await base44.entities.PaperTrade.filter(
      { is_backtest: true },
      "-entry_at",
      2500
    );
    const existingByKey = new Map(existingTrades.map((t: any) => [t.trade_key, t]));

    const batch = STRATEGY_PRESETS.slice(offset, offset + limit);
    const summary: any[] = [];
    const priceCache = new Map<string, number | null>();
    const gammaBudget = { left: MAX_GAMMA_LOOKUPS };

    for (const preset of batch) {
      const clusters = findHistoricalClusters(buys, walletsByAddress, preset.params, now);
      const simulated: ReturnType<typeof simulatePaperTrade>[] = [];

      for (const cluster of clusters) {
        const entryMs = new Date(cluster.last_buy_at).getTime() + preset.params.delaySec * 1000;
        const resolution = await resolveWithPriceFallback(
          cluster.condition_id,
          cluster.outcome_index ?? 0,
          entryMs,
          allActivities,
          priceCache,
          gammaBudget,
          now
        );

        const trade = simulatePaperTrade(cluster, preset.strategy_id, preset.params, resolution);
        simulated.push(trade);

        const existing = existingByKey.get(trade.trade_key);
        if (existing) {
          const unchanged =
            existing.status === trade.status &&
            existing.pnl_usd === trade.pnl_usd &&
            existing.entry_price === trade.entry_price;
          if (!unchanged) {
            await base44.entities.PaperTrade.update(existing.id, {
              ...trade,
              strategy_id: preset.strategy_id,
              is_backtest: true,
            });
          }
        } else {
          const created = await base44.entities.PaperTrade.create({
            ...trade,
            strategy_id: preset.strategy_id,
            is_backtest: true,
          });
          existingByKey.set(trade.trade_key, created);
        }
      }

      const stats = aggregateStats(simulated);
      const strategyRows = await base44.entities.PaperStrategy.filter({
        strategy_id: preset.strategy_id,
      });
      if (strategyRows.length) {
        await base44.entities.PaperStrategy.update(strategyRows[0].id, {
          ...stats,
          last_backtest_at: now.toISOString(),
        });
      }

      summary.push({
        strategy_id: preset.strategy_id,
        name: preset.name,
        clusters: clusters.length,
        ...stats,
      });
    }

    const remaining = full ? 0 : Math.max(STRATEGY_PRESETS.length - offset - batch.length, 0);

    return Response.json({
      full,
      offset,
      limit,
      processed: batch.length,
      remaining,
      totalPresets: STRATEGY_PRESETS.length,
      buysSampled: buys.length,
      redeemsSampled: redeems.length,
      gammaLookups: MAX_GAMMA_LOOKUPS - gammaBudget.left,
      summary: summary.sort((a, b) => (b.roi || 0) - (a.roi || 0)),
    });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
