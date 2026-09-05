// Paper-trading strategy presets — a grid of consensus + execution variants
// to compare which rules actually make money on historical synced data.

export interface StrategyParams {
  minWallets: number;
  windowHours: number;
  grades: ("A" | "B")[];
  minConfidence: "medium" | "high";
  qualities: ("strong" | "caution" | "blocked")[];
  maxPriceDrift: number;
  minTotalUsdc?: number;
  delaySec: number;
  slippage: number;
  feeRate: number;
  stakeUsd: number;
  lookbackDays: number;
}

export interface StrategyPreset {
  strategy_id: string;
  name: string;
  params: StrategyParams;
}

const BASE: StrategyParams = {
  minWallets: 3,
  windowHours: 6,
  grades: ["A", "B"],
  minConfidence: "medium",
  qualities: ["strong"],
  maxPriceDrift: 0.02,
  delaySec: 30,
  slippage: 0.01,
  feeRate: 0.01,
  stakeUsd: 100,
  lookbackDays: 30,
};

function preset(
  strategy_id: string,
  name: string,
  overrides: Partial<StrategyParams>
): StrategyPreset {
  return { strategy_id, name, params: { ...BASE, ...overrides } };
}

/** ~20 variants covering wallet count, window, grade gate, drift, slippage, delay. */
export const STRATEGY_PRESETS: StrategyPreset[] = [
  preset("baseline-3ab-6h", "Baseline: 3 wallets, A/B, 6h, strong", {}),
  preset("strict-4ab-6h", "Strict: 4 wallets, A/B, 6h", { minWallets: 4 }),
  preset("strict-5ab-6h", "Strict: 5 wallets, A/B, 6h", { minWallets: 5 }),
  preset("elite-3a-high-6h", "Elite: 3 A-grade, high confidence", {
    grades: ["A"],
    minConfidence: "high",
  }),
  preset("elite-4a-high-6h", "Elite: 4 A-grade, high confidence", {
    minWallets: 4,
    grades: ["A"],
    minConfidence: "high",
  }),
  preset("fast-3ab-3h", "Fast window: 3 wallets, 3h", { windowHours: 3 }),
  preset("slow-3ab-12h", "Slow window: 3 wallets, 12h", { windowHours: 12 }),
  preset("slow-3ab-24h", "Slow window: 3 wallets, 24h", { windowHours: 24 }),
  preset("wide-2ab-6h", "Wide net: 2 wallets (risky)", { minWallets: 2 }),
  preset("tight-drift-3ab-6h", "Tight drift: max 1¢", { maxPriceDrift: 0.01 }),
  preset("loose-drift-3ab-6h", "Loose drift: max 3¢", { maxPriceDrift: 0.03 }),
  preset("incl-caution-3ab-6h", "Include caution signals", {
    qualities: ["strong", "caution"],
    maxPriceDrift: 0.05,
  }),
  preset("whale-3ab-6h-500", "Whale filter: $500+ skilled volume", {
    minTotalUsdc: 500,
  }),
  preset("whale-4ab-6h-1000", "Whale filter: 4 wallets + $1k volume", {
    minWallets: 4,
    minTotalUsdc: 1000,
  }),
  preset("low-slip-3ab-6h", "Optimistic fill: 0.5¢ slippage", { slippage: 0.005 }),
  preset("high-slip-3ab-6h", "Pessimistic fill: 2¢ slippage", { slippage: 0.02 }),
  preset("delay-5s-3ab-6h", "Fast bot: 5s delay", { delaySec: 5 }),
  preset("delay-60s-3ab-6h", "Slow bot: 60s delay", { delaySec: 60 }),
  preset("delay-120s-3ab-6h", "Very slow: 2min delay", { delaySec: 120 }),
  preset("small-stake-3ab-6h", "Small size: $25/trade", { stakeUsd: 25 }),
  preset("large-stake-3ab-6h", "Large size: $250/trade", { stakeUsd: 250 }),
];

export function walletMatchesStrategy(wallet: any, params: StrategyParams): boolean {
  const grade = wallet?.skill_grade;
  const conf = wallet?.score_confidence;
  if (!grade || !conf) return false;
  if (!params.grades.includes(grade)) return false;
  if (params.minConfidence === "high" && conf !== "high") return false;
  if (params.minConfidence === "medium" && conf !== "medium" && conf !== "high") return false;
  return true;
}

export function alertMatchesStrategy(alert: any, params: StrategyParams): boolean {
  if (!params.qualities.includes(alert.quality)) return false;
  if (alert.price_drift != null && alert.price_drift > params.maxPriceDrift) return false;
  if (params.minTotalUsdc && (alert.total_usdc || 0) < params.minTotalUsdc) return false;
  if (alert.wallet_count < params.minWallets) return false;
  return true;
}
