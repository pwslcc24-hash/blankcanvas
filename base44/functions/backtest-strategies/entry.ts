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
const WALLET_BATCH = 2;
const MAX_GAMMA_LOOKUPS = 20;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureStrategyRows(base44: any) {
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
}

async function fetchSkilledBuys(base44: any, wallets: any[]): Promise<any[]> {
  const skilled = wallets.filter(isSkilledForConsensus);
  const buys: any[] = [];
  for (let i = 0; i < skilled.length; i += WALLET_BATCH) {
    const batch = skilled.slice(i, i + WALLET_BATCH);
    for (const wallet of batch) {
      try {
        const rows = await withRetry(() =>
          base44.entities.WalletActivity.filter(
            { wallet_address: wallet.address, event_type: "TRADE", side: "BUY" },
            "-occurred_at",
            ACTIVITY_PER_WALLET
          )
        );
        buys.push(...rows);
      } catch {
        /* skip wallet */
      }
      await sleep(350);
    }
  }
  return buys;
}

async function fetchSkilledRedeems(base44: any, wallets: any[]): Promise<any[]> {
  const skilled = wallets.filter(isSkilledForConsensus);
  const redeems: any[] = [];
  for (let i = 0; i < skilled.length; i += WALLET_BATCH) {
    const batch = skilled.slice(i, i + WALLET_BATCH);
    for (const wallet of batch) {
      try {
        const rows = await withRetry(() =>
          base44.entities.WalletActivity.filter(
            { wallet_address: wallet.address, event_type: "REDEEM" },
            "-occurred_at",
            80
          )
        );
        redeems.push(...rows);
      } catch {
        /* skip wallet */
      }
      await sleep(350);
    }
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
    await sleep(100);
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

async function refreshStatsFromDb(base44: any, now: Date) {
  const allTrades = await base44.entities.PaperTrade.filter(
    { is_backtest: true },
    "-entry_at",
    2500
  );
  const byStrategy = new Map<string, any[]>();
  for (const t of allTrades) {
    if (!byStrategy.has(t.strategy_id)) byStrategy.set(t.strategy_id, []);
    byStrategy.get(t.strategy_id)!.push(t);
  }

  const summary: any[] = [];
  for (const preset of STRATEGY_PRESETS) {
    const trades = byStrategy.get(preset.strategy_id) || [];
    const stats = aggregateStats(trades);
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
      clusters: trades.length,
      ...stats,
    });
  }
  return summary;
}

async function simulatePresets(
  base44: any,
  presets: typeof STRATEGY_PRESETS,
  buys: any[],
  redeems: any[],
  walletsByAddress: Map<string, any>,
  existingByKey: Map<string, any>,
  now: Date
) {
  const allActivities = [...buys, ...redeems];
  const priceCache = new Map<string, number | null>();
  const gammaBudget = { left: MAX_GAMMA_LOOKUPS };
  const summary: any[] = [];

  for (const preset of presets) {
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
              pnl_usd: trade.pnl_usd ?? null,
              exit_at: trade.exit_at ?? null,
              exit_price: trade.exit_price ?? null,
            });
          }
      } else {
        const created = await base44.entities.PaperTrade.create({
          ...trade,
          strategy_id: preset.strategy_id,
          is_backtest: true,
        });
        existingByKey.set(trade.trade_key, created);
        await sleep(50);
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

    await sleep(300);
  }

  return summary;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const force = body?.force === true || body?.force === "true";
    const refreshOnly = body?.refresh === true || body?.refresh === "true";
    const now = new Date();

    await ensureStrategyRows(base44);

    // Fast path: recompute leaderboard from trades already in the DB
    if (refreshOnly && !force) {
      const summary = await refreshStatsFromDb(base44, now);
      return Response.json({
        mode: "refresh",
        processed: STRATEGY_PRESETS.length,
        summary: summary.sort((a, b) => (b.roi || 0) - (a.roi || 0)),
      });
    }

    const existingTrades = await base44.entities.PaperTrade.filter(
      { is_backtest: true },
      "-entry_at",
      2500
    );
    const existingByKey = new Map(existingTrades.map((t: any) => [t.trade_key, t]));
    const tradeCountByStrategy = new Map<string, number>();
    for (const t of existingTrades) {
      tradeCountByStrategy.set(t.strategy_id, (tradeCountByStrategy.get(t.strategy_id) || 0) + 1);
    }

    // Smart default: refresh saved trades, then only simulate strategies still at zero
    const presetsToSimulate = force
      ? STRATEGY_PRESETS
      : STRATEGY_PRESETS.filter((p) => (tradeCountByStrategy.get(p.strategy_id) || 0) === 0);

    let buys: any[] = [];
    let redeems: any[] = [];
    let simulatedSummary: any[] = [];

    if (presetsToSimulate.length > 0) {
      const wallets = await base44.entities.TrackedWallet.filter({ is_active: true });
      const walletsByAddress = new Map(wallets.map((w: any) => [w.address, w]));
      buys = await fetchSkilledBuys(base44, wallets);
      redeems = await fetchSkilledRedeems(base44, wallets);
      simulatedSummary = await simulatePresets(
        base44,
        presetsToSimulate,
        buys,
        redeems,
        walletsByAddress,
        existingByKey,
        now
      );
    }

    // Always refresh full leaderboard after any simulation
    const summary = await refreshStatsFromDb(base44, now);

    return Response.json({
      mode: force ? "full" : presetsToSimulate.length ? "smart" : "refresh",
      simulated: presetsToSimulate.length,
      skipped: STRATEGY_PRESETS.length - presetsToSimulate.length,
      buysSampled: buys.length,
      redeemsSampled: redeems.length,
      summary: summary.sort((a, b) => (b.roi || 0) - (a.roi || 0)),
      newSummary: simulatedSummary,
    });
  } catch (err: any) {
    const message = String(err?.message || err);
    const rateLimited = /rate limit/i.test(message);
    return Response.json(
      {
        error: rateLimited
          ? "Rate limit — wait 2 minutes and click Refresh. Your saved trades are still there."
          : message,
        rateLimited,
      },
      { status: rateLimited ? 429 : 500 }
    );
  }
}
