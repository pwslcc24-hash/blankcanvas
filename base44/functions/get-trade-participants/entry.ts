import { createClientFromRequest } from "npm:@base44/sdk";
import { buildParticipantsForSignal } from "../../shared/paper-trading.ts";
import { STRATEGY_PRESETS } from "../../shared/strategies.ts";
import { withRetry } from "../../shared/retry.ts";

const ACTIVITY_LIMIT = 200;
const WALLET_BATCH = 6;

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const conditionId = body?.condition_id;
    const outcomeIndex = body?.outcome_index;
    const signalAt = body?.signal_at;
    const strategyId = body?.strategy_id;

    if (!conditionId || outcomeIndex == null || !signalAt || !strategyId) {
      return Response.json({ error: "Missing condition_id, outcome_index, signal_at, or strategy_id" }, { status: 400 });
    }

    const preset = STRATEGY_PRESETS.find((p) => p.strategy_id === strategyId);
    if (!preset) {
      return Response.json({ error: "Unknown strategy_id" }, { status: 404 });
    }

    const wallets = await base44.entities.TrackedWallet.filter({ is_active: true });
    const walletsByAddress = new Map(wallets.map((w: any) => [w.address, w]));
    const eligible = wallets.filter((w: any) => {
      const grade = w?.skill_grade;
      const conf = w?.score_confidence;
      if (!grade || !conf) return false;
      if (!preset.params.grades.includes(grade)) return false;
      if (preset.params.minConfidence === "high" && conf !== "high") return false;
      return true;
    });

    const buys: any[] = [];
    for (let i = 0; i < eligible.length; i += WALLET_BATCH) {
      const batch = eligible.slice(i, i + WALLET_BATCH);
      const chunks = await Promise.all(
        batch.map(async (wallet: any) => {
          try {
            return await withRetry(() =>
              base44.entities.WalletActivity.filter(
                { wallet_address: wallet.address, event_type: "TRADE", side: "BUY" },
                "-occurred_at",
                ACTIVITY_LIMIT
              )
            );
          } catch {
            return [];
          }
        })
      );
      for (const rows of chunks) buys.push(...rows);
    }

    const participants = buildParticipantsForSignal(
      buys,
      walletsByAddress,
      preset.params,
      conditionId,
      Number(outcomeIndex),
      signalAt
    );

    return Response.json({ participants, wallet_count: participants.length });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
