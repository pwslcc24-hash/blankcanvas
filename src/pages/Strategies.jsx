import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import { FlaskConical, Loader2, RefreshCw, Trophy, TrendingUp, Users, ExternalLink } from "lucide-react";
import { tradePolymarketUrlSync, openTradePolymarketUrl } from "@/lib/polymarketLinks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const GRADE_STYLES = {
  A: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  B: "bg-blue-500/10 text-blue-600 border-blue-500/20",
};

function strategyGradeLabel(params) {
  if (!params?.grades?.length) return null;
  if (params.grades.length === 1 && params.grades[0] === "A") {
    return params.minConfidence === "high" ? "A+" : "A";
  }
  return "A/B";
}

function usd(value) {
  const n = Number(value || 0);
  const sign = n >= 0 ? "" : "-";
  return (
    sign +
    Math.abs(n).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    })
  );
}

function pct(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function cents(price) {
  if (price == null || !Number.isFinite(Number(price))) return "—";
  return `${(Number(price) * 100).toFixed(1)}¢`;
}

function formatWhen(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDay(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function earliestLiveDay(trades) {
  if (!trades?.length) return null;
  let min = Infinity;
  for (const t of trades) {
    const ms = new Date(t.entry_at || t.signal_at).getTime();
    if (Number.isFinite(ms) && ms < min) min = ms;
  }
  return min === Infinity ? null : new Date(min).toISOString();
}

function tradeDateRange(trades) {
  if (!trades?.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const t of trades) {
    const ms = new Date(t.entry_at || t.signal_at).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  if (!Number.isFinite(min)) return null;
  return { start: new Date(min), end: new Date(max) };
}

function combineDateRange(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return {
    start: new Date(Math.min(a.start.getTime(), b.start.getTime())),
    end: new Date(Math.max(a.end.getTime(), b.end.getTime())),
  };
}

function formatRange(range) {
  if (!range) return null;
  const a = formatDay(range.start.toISOString());
  const b = formatDay(range.end.toISOString());
  return a === b ? a : `${a} – ${b}`;
}

function parseParams(strategy) {
  try {
    return JSON.parse(strategy?.params_json || "{}");
  } catch {
    return {};
  }
}

function describeStrategy(params) {
  if (!params.minWallets) return "Strategy rules loading…";
  const gradeLabel =
    params.grades?.length === 1 && params.grades[0] === "A"
      ? "A-grade wallets only"
      : "A or B grade wallets";
  const confLabel = params.minConfidence === "high" ? " (high confidence)" : "";
  const parts = [
    `${params.minWallets}+ ${gradeLabel}${confLabel}`,
    `${params.windowHours}h window`,
    `$${params.stakeUsd}/trade`,
  ];
  if (params.minTotalUsdc) parts.push(`$${params.minTotalUsdc}+ volume`);
  return parts.join(" · ");
}

function moneyOut(trade) {
  if (trade.status === "open") return null;
  if (trade.exit_price != null && trade.shares != null) {
    return trade.shares * trade.exit_price;
  }
  if (trade.pnl_usd != null && trade.stake_usd != null) {
    return trade.stake_usd + trade.pnl_usd;
  }
  return null;
}

function statsFromStrategyEntity(strategy) {
  if (!strategy) {
    return statsFromTrades([]);
  }
  const resolved = strategy.resolved_trades || 0;
  const staked = Number(strategy.total_staked_usd || 0);
  const pnl = Number(strategy.total_pnl_usd || 0);
  return {
    total: strategy.total_trades || 0,
    resolved,
    open: strategy.open_trades || 0,
    staked,
    pnl,
    gotBack: staked + pnl,
    roi: strategy.roi ?? (staked > 0 ? pnl / staked : null),
    winRate: strategy.win_rate ?? null,
    wins: strategy.wins || 0,
    losses: strategy.losses || 0,
  };
}

function statsFromTrades(trades) {
  const resolved = trades.filter((t) => t.status === "won" || t.status === "lost");
  const staked = resolved.reduce((s, t) => s + Number(t.stake_usd || 0), 0);
  const pnl = resolved.reduce((s, t) => s + Number(t.pnl_usd || 0), 0);
  const wins = resolved.filter((t) => t.status === "won").length;
  return {
    total: trades.length,
    resolved: resolved.length,
    open: trades.filter((t) => t.status === "open").length,
    staked,
    pnl,
    gotBack: staked + pnl,
    roi: staked > 0 ? pnl / staked : null,
    winRate: resolved.length > 0 ? wins / resolved.length : null,
    wins,
    losses: resolved.length - wins,
  };
}

function combineStats(a, b) {
  const resolved = (a.resolved || 0) + (b.resolved || 0);
  const open = (a.open || 0) + (b.open || 0);
  const staked = (a.staked || 0) + (b.staked || 0);
  const pnl = (a.pnl || 0) + (b.pnl || 0);
  const wins = (a.wins || 0) + (b.wins || 0);
  return {
    total: (a.total || 0) + (b.total || 0),
    resolved,
    open,
    staked,
    pnl,
    gotBack: staked + pnl,
    roi: staked > 0 ? pnl / staked : null,
    winRate: resolved > 0 ? wins / resolved : null,
    wins,
    losses: resolved - wins,
  };
}

function confidenceScore(allStats, liveStats) {
  let score = 0;
  const allN = allStats.resolved || 0;
  const pastN = (allStats.resolved || 0) - (liveStats.resolved || 0);
  const liveN = liveStats.resolved || 0;
  const allRoi = allStats.roi ?? 0;
  const liveRoi = liveStats.roi ?? 0;

  if (allN >= 30) score += 40;
  else if (allN >= 20) score += 32;
  else if (allN >= 10) score += 24;
  else if (allN >= 5) score += 15;
  else if (allN >= 1) score += 5;

  if (allRoi >= 0.2) score += 25;
  else if (allRoi >= 0.1) score += 20;
  else if (allRoi >= 0.05) score += 15;
  else if (allRoi >= 0) score += 8;

  if (allN >= 10) {
    const wr = allStats.winRate ?? 0;
    if (wr >= 0.55 && wr <= 0.8) score += 15;
    else if (wr > 0.8) score += 10;
    else if (wr >= 0.45) score += 8;
    else score += 3;
  } else if (allN >= 5 && (allStats.winRate ?? 0) >= 0.6) {
    score += 8;
  }

  if (liveN >= 10) {
    if (liveRoi >= 0) score += 20;
    else score += 5;
  } else if (liveN >= 5) {
    if (liveRoi >= 0) score += 14;
    else score += 4;
  } else if (liveN >= 1) {
    score += liveRoi >= 0 ? 6 : 2;
  }

  if (pastN >= 10 && liveN >= 3) score += 5;

  const clamped = Math.min(100, Math.max(0, score));
  let label = "Not ready";
  let className = "bg-red-500/10 text-red-700 border-red-500/30";
  let advice = "Need more past-test trades before considering real money.";
  if (clamped >= 75) {
    label = "High";
    className = "bg-emerald-500/10 text-emerald-700 border-emerald-500/30";
    advice = "Strong candidate — still start small and keep watching live paper.";
  } else if (clamped >= 50) {
    label = "Moderate";
    className = "bg-blue-500/10 text-blue-700 border-blue-500/30";
    advice = "Promising but keep paper trading until you hit 30+ past trades.";
  } else if (clamped >= 25) {
    label = "Low";
    className = "bg-amber-500/10 text-amber-700 border-amber-500/30";
    advice = "Too early to trust — wait for more finished trades.";
  }

  return { score: clamped, label, className, advice };
}

function allStatsForStrategy(strategy, liveStatsByStrategy) {
  const past = statsFromStrategyEntity(strategy);
  const live = liveStatsByStrategy.get(strategy?.strategy_id) || statsFromTrades([]);
  return combineStats(past, live);
}

function PerformanceSummary({ pastStats, liveStats, allStats, confidence, stakePerTrade, pastRange, liveRange, allRange }) {
  return (
    <Card className="border-2 border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Performance at a glance</CardTitle>
        <CardDescription>Past + live combined — use all-time % to pick a strategy</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-lg border-2 border-primary/40 p-3 bg-primary/[0.04] lg:col-span-1 order-first">
            <p className="text-[11px] uppercase tracking-wide font-medium text-foreground">All time ★</p>
            <p className={cn("text-2xl font-bold mt-1", (allStats.roi ?? 0) >= 0 ? "text-emerald-600" : "text-red-600")}>
              {allStats.resolved > 0 ? pct(allStats.roi) : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{allStats.resolved} finished total</p>
            {allStats.resolved > 0 && (
              <p className="text-xs text-muted-foreground">
                {usd(allStats.pnl)} net · {pct(allStats.winRate)} win rate
              </p>
            )}
            {allRange && (
              <p className="text-[10px] text-muted-foreground mt-1">Trades from {formatRange(allRange)}</p>
            )}
            <p className="text-[10px] text-muted-foreground mt-1">Use this to pick a strategy</p>
          </div>
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/[0.04] p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Past test</p>
            <p className={cn("text-xl font-bold mt-1", (pastStats.roi ?? 0) >= 0 ? "text-emerald-600" : "text-red-600")}>
              {pastStats.resolved > 0 ? pct(pastStats.roi) : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {pastStats.resolved} finished · {pastStats.open} open
            </p>
            {pastRange && (
              <p className="text-[10px] text-muted-foreground">Replay data: {formatRange(pastRange)}</p>
            )}
            {pastStats.resolved > 0 && (
              <p className="text-xs text-muted-foreground">{usd(pastStats.pnl)} net · ${stakePerTrade}/trade</p>
            )}
          </div>
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Live paper</p>
            <p className={cn("text-xl font-bold mt-1", (liveStats.roi ?? 0) >= 0 ? "text-emerald-600" : "text-red-600")}>
              {liveStats.resolved > 0 ? pct(liveStats.roi) : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {liveStats.resolved} finished · {liveStats.open} open
            </p>
            {liveRange && (
              <p className="text-[10px] text-muted-foreground">Forward test: {formatRange(liveRange)}</p>
            )}
            {liveStats.resolved > 0 && (
              <p className="text-xs text-muted-foreground">{usd(liveStats.pnl)} net</p>
            )}
          </div>
          <div className="rounded-lg border border-primary/20 p-3 bg-background">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Confidence</p>
            <div className="flex items-baseline gap-2 mt-1">
              <p className="text-xl font-bold">{confidence.score}</p>
              <Badge variant="outline" className={cn("text-xs", confidence.className)}>
                {confidence.label}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-2 leading-snug">{confidence.advice}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MetricTile({ label, value, sub, tone }) {
  return (
    <div className="rounded-lg border bg-background p-3 min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold mt-0.5 truncate",
          tone === "up" && "text-emerald-600",
          tone === "down" && "text-red-600"
        )}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

function StatsDashboard({ title, hint, variant, stats, stakePerTrade, dateRange }) {
  const profitable = (stats.pnl || 0) >= 0;
  const hasData = stats.resolved > 0 || stats.open > 0;

  return (
    <Card
      className={cn(
        variant === "live" ? "border-amber-500/40 bg-amber-500/[0.03]" : "border-blue-500/40 bg-blue-500/[0.03]"
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <Badge variant="outline" className="text-xs shrink-0">
            {variant === "live" ? "Forward test" : "History replay"}
          </Badge>
        </div>
        <CardDescription>
          {hint}
          {dateRange && <> · {formatRange(dateRange)}</>}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="text-sm text-muted-foreground">No trades yet.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <MetricTile label="Finished" value={stats.resolved} sub={`${stakePerTrade}/trade`} />
            <MetricTile label="Open" value={stats.open} sub={stats.open ? "pending" : "none"} />
            <MetricTile label="Total bet" value={stats.resolved > 0 ? usd(stats.staked) : "—"} />
            <MetricTile
              label="Got back"
              value={stats.resolved > 0 ? usd(stats.gotBack) : "—"}
            />
            <MetricTile
              label="Net P/L"
              value={stats.resolved > 0 ? usd(stats.pnl) : "—"}
              tone={stats.resolved > 0 ? (profitable ? "up" : "down") : undefined}
            />
            <MetricTile
              label="Return"
              value={stats.resolved > 0 ? pct(stats.roi) : "—"}
              tone={stats.resolved > 0 ? (profitable ? "up" : "down") : undefined}
            />
            <MetricTile
              label="Win rate"
              value={stats.resolved > 0 ? pct(stats.winRate) : "—"}
              sub={stats.resolved > 0 ? `${stats.wins}W · ${stats.losses}L` : undefined}
            />
            <MetricTile
              label="Avg/trade"
              value={
                stats.resolved > 0 ? usd(stats.pnl / stats.resolved) : "—"
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function shortAddress(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function findAlertForTrade(trade, alerts) {
  const exact = alerts.find((a) => a.signal_key === trade.signal_key);
  if (exact) return exact;

  const signalMs = new Date(trade.signal_at || trade.entry_at).getTime();
  let best = null;
  let bestDiff = Infinity;

  for (const alert of alerts) {
    if (alert.condition_id !== trade.condition_id) continue;
    if (alert.outcome_index != null && trade.outcome_index != null && alert.outcome_index !== trade.outcome_index) {
      continue;
    }
    const t = new Date(alert.last_buy_at || alert.detected_at).getTime();
    const diff = Math.abs(t - signalMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = alert;
    }
  }

  // Only use fuzzy match if within 24h — avoids wrong market reuse
  if (best && bestDiff <= 24 * 3600 * 1000) return best;
  return null;
}

function parseParticipants(trade, alerts) {
  if (trade.participants_json) {
    try {
      const parsed = JSON.parse(trade.participants_json);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* fall through */
    }
  }
  const alert = findAlertForTrade(trade, alerts);
  if (alert?.participants_json) {
    try {
      return JSON.parse(alert.participants_json);
    } catch {
      return [];
    }
  }
  return [];
}

function trustLabel(resolved) {
  if (resolved >= 30) return { text: "Proven", className: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30" };
  if (resolved >= 10) return { text: "Promising", className: "bg-blue-500/10 text-blue-700 border-blue-500/30" };
  if (resolved >= 5) return { text: "Early", className: "bg-amber-500/10 text-amber-700 border-amber-500/30" };
  return { text: "Too few trades", className: "bg-muted text-muted-foreground" };
}

function ParticipantsList({ participants }) {
  if (!participants.length) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No wallet details found for this signal.
      </p>
    );
  }

  return (
    <div className="rounded-md border overflow-x-auto max-h-[360px] overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Wallet</TableHead>
            <TableHead className="w-[70px]">Grade</TableHead>
            <TableHead className="w-[80px] text-right">Buy</TableHead>
            <TableHead className="w-[90px] text-right">Size</TableHead>
            <TableHead className="w-[120px]">When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {participants.map((p) => (
            <TableRow key={p.address}>
              <TableCell>
                <Link to={`/wallets/${p.address}`} className="text-sm font-medium text-primary hover:underline">
                  {p.label || shortAddress(p.address)}
                </Link>
                {p.label && <p className="text-xs text-muted-foreground font-mono">{shortAddress(p.address)}</p>}
              </TableCell>
              <TableCell>
                {p.grade ? (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      p.grade === "A" && GRADE_STYLES.A,
                      p.grade === "B" && GRADE_STYLES.B
                    )}
                  >
                    {p.grade}
                    {p.score != null ? ` ${Math.round(p.score)}` : ""}
                  </Badge>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="text-right text-sm">{cents(p.price)}</TableCell>
              <TableCell className="text-right text-sm">{usd(p.usdc_size)}</TableCell>
              <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                {formatWhen(p.occurred_at)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TradeTable({ trades, alerts, polymarketUrls, onViewWallets, onOpenBet, loadingTradeKey }) {
  if (!trades.length) {
    return <p className="text-sm text-muted-foreground px-6 py-8 text-center">No trades in this view.</p>;
  }

  return (
    <div className="w-full overflow-x-auto">
      <Table className="min-w-[900px] w-full">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[130px]">Entered</TableHead>
            <TableHead className="w-[130px]">Finished</TableHead>
            <TableHead className="min-w-[260px]">Market</TableHead>
            <TableHead className="w-[100px]">Bet</TableHead>
            <TableHead className="w-[110px]">Wallets</TableHead>
            <TableHead className="w-[90px] text-right">Put in</TableHead>
            <TableHead className="w-[90px] text-right">Got back</TableHead>
            <TableHead className="w-[90px] text-right">P/L</TableHead>
            <TableHead className="w-[80px]">Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((t) => {
            const out = moneyOut(t);
            const statusLabel = t.status === "won" ? "Won" : t.status === "lost" ? "Lost" : "Open";
            const tradeKey = t.id || t.trade_key;
            const loading = loadingTradeKey === tradeKey;
            return (
              <TableRow
                key={tradeKey}
                className="hover:bg-muted/30 cursor-pointer"
                onClick={() => onViewWallets(t)}
              >
                <TableCell className="text-sm whitespace-nowrap">
                  {formatWhen(t.entry_at)}
                  <span className="text-muted-foreground"> · {cents(t.entry_price)}</span>
                </TableCell>
                <TableCell className="text-sm whitespace-nowrap">
                  {t.status === "open" ? (
                    <span className="text-amber-600">Open</span>
                  ) : (
                    <>
                      {formatWhen(t.exit_at)}
                      <span className="text-muted-foreground">
                        {" "}
                        · {t.status === "lost" ? "0¢" : cents(t.exit_price)}
                      </span>
                    </>
                  )}
                </TableCell>
                <TableCell>
                  <p className="text-sm truncate max-w-[320px]" title={t.market_title}>
                    {t.market_title || "Unknown market"}
                  </p>
                  <button
                    type="button"
                    className="text-xs text-blue-600 font-medium hover:underline inline-flex items-center gap-1 mt-0.5"
                    disabled={loading}
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewWallets(t);
                    }}
                  >
                    {loading ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Users className="w-3 h-3" />
                    )}
                    See {t.wallet_count} wallets
                  </button>
                </TableCell>
                <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                  {(() => {
                    const url = tradePolymarketUrlSync(t, alerts, polymarketUrls);
                    const label = t.outcome || "—";
                    if (label === "—") {
                      return <span className="text-muted-foreground">{label}</span>;
                    }
                    if (url) {
                      return (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
                          title="Open this bet on Polymarket"
                        >
                          {label}
                          <ExternalLink className="w-3 h-3 shrink-0 opacity-70" />
                        </a>
                      );
                    }
                    return (
                      <button
                        type="button"
                        className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
                        title="Open this bet on Polymarket"
                        onClick={() => onOpenBet(t)}
                      >
                        {label}
                        <ExternalLink className="w-3 h-3 shrink-0 opacity-70" />
                      </button>
                    );
                  })()}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8 text-xs whitespace-nowrap bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                    disabled={loading}
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewWallets(t);
                    }}
                  >
                    {loading ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <>
                        <Users className="w-3 h-3 mr-1" />
                        See wallets
                      </>
                    )}
                  </Button>
                </TableCell>
                <TableCell className="text-right text-sm">{usd(t.stake_usd)}</TableCell>
                <TableCell className="text-right text-sm">
                  {t.status === "open" ? (
                    <span className="text-muted-foreground">—</span>
                  ) : t.status === "lost" ? (
                    <span className="text-red-600">$0.00</span>
                  ) : (
                    usd(out)
                  )}
                </TableCell>
                <TableCell className="text-right text-sm font-medium">
                  {t.status === "open" ? (
                    <span className="text-muted-foreground">pending</span>
                  ) : t.pnl_usd != null ? (
                    <span className={t.pnl_usd >= 0 ? "text-emerald-600" : "text-red-600"}>
                      {t.pnl_usd >= 0 ? "+" : ""}
                      {usd(t.pnl_usd)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs",
                      t.status === "won" && "text-emerald-600 border-emerald-500/30",
                      t.status === "lost" && "text-red-600 border-red-500/30",
                      t.status === "open" && "text-amber-600 border-amber-500/30"
                    )}
                  >
                    {statusLabel}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function Strategies() {
  const [strategies, setStrategies] = useState([]);
  const [trades, setTrades] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [backtesting, setBacktesting] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [liveTradesAll, setLiveTradesAll] = useState([]);
  const [tradeFilter, setTradeFilter] = useState("finished");
  const [participantsCache, setParticipantsCache] = useState({});
  const [walletDialogTrade, setWalletDialogTrade] = useState(null);
  const [walletDialogParticipants, setWalletDialogParticipants] = useState([]);
  const [walletDialogLoading, setWalletDialogLoading] = useState(false);
  const [loadingTradeKey, setLoadingTradeKey] = useState(null);
  const [polymarketUrls, setPolymarketUrls] = useState({});
  const resolvingLinksRef = useRef(new Set());

  const [globalPastStart, setGlobalPastStart] = useState(null);

  useEffect(() => {
    setPolymarketUrls({});
    resolvingLinksRef.current = new Set();
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    const resolveLinks = async () => {
      for (const t of trades.slice(0, 100)) {
        const key = t.id || t.trade_key;
        if (!key || cancelled) continue;

        const syncUrl = tradePolymarketUrlSync(t, alerts, {});
        if (syncUrl) {
          setPolymarketUrls((prev) => (prev[key] ? prev : { ...prev, [key]: syncUrl }));
          continue;
        }

        if (resolvingLinksRef.current.has(key)) continue;
        resolvingLinksRef.current.add(key);

        try {
          const alert = findAlertForTrade(t, alerts);
          const res = await base44.functions.invoke("resolve-polymarket-url", {
            condition_id: t.condition_id,
            market_title: t.market_title,
            market_slug: t.market_slug || alert?.market_slug,
          });
          if (!cancelled && res.data?.url) {
            setPolymarketUrls((prev) => ({ ...prev, [key]: res.data.url }));
          }
        } catch {
          /* best-effort */
        }
      }
    };
    if (trades.length) resolveLinks();
    return () => {
      cancelled = true;
    };
  }, [trades, alerts]);

  const load = useCallback(async () => {
    try {
      const [s, a, live, pastEarliest] = await Promise.all([
        base44.entities.PaperStrategy.list("-roi", 50),
        base44.entities.ConsensusAlert.list("-detected_at", 300),
        base44.entities.PaperTrade.filter({ is_backtest: false }, "-entry_at", 800),
        base44.entities.PaperTrade.filter({ is_backtest: true }, "entry_at", 1),
      ]);
      setStrategies(s);
      setAlerts(a);
      setLiveTradesAll(live);
      setGlobalPastStart(pastEarliest[0]?.entry_at || null);
      if (!selectedId && s.length) {
        const withTrades = s.filter((x) => (x.total_trades || 0) > 0);
        setSelectedId((withTrades[0] || s[0]).strategy_id);
      }
    } catch (err) {
      toast({
        title: "Failed to load strategies",
        description: err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const reloadTrades = useCallback(async (strategyId) => {
    if (!strategyId) return;
    const t = await base44.entities.PaperTrade.filter(
      { strategy_id: strategyId },
      "-entry_at",
      500
    );
    setTrades(t);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    reloadTrades(selectedId).catch((err) => {
      toast({
        title: "Failed to load trades",
        description: err?.message || String(err),
        variant: "destructive",
      });
    });
  }, [selectedId, reloadTrades]);

  useEffect(() => {
    setParticipantsCache({});
    setWalletDialogTrade(null);
  }, [selectedId]);

  const tradeKey = (trade) => trade?.id || trade?.trade_key;

  const loadParticipantsForTrade = useCallback(
    async (trade) => {
      const key = tradeKey(trade);
      const cached = participantsCache[key];
      if (cached?.length) return cached;

      const fromAlert = parseParticipants(trade, alerts);
      if (fromAlert.length) {
        setParticipantsCache((prev) => ({ ...prev, [key]: fromAlert }));
        return fromAlert;
      }

      setLoadingTradeKey(key);
      try {
        const res = await base44.functions.invoke("get-trade-participants", {
          condition_id: trade.condition_id,
          outcome_index: trade.outcome_index,
          signal_at: trade.signal_at || trade.entry_at,
          strategy_id: trade.strategy_id || selectedId,
        });
        if (res.data?.error) {
          throw new Error(res.data.error);
        }
        const list = res.data?.participants || [];
        setParticipantsCache((prev) => ({ ...prev, [key]: list }));
        return list;
      } catch (err) {
        toast({
          title: "Couldn't load wallets",
          description: err?.response?.data?.error || err?.message || String(err),
          variant: "destructive",
        });
        return [];
      } finally {
        setLoadingTradeKey(null);
      }
    },
    [alerts, participantsCache, selectedId]
  );

  const openWalletDialog = useCallback(
    async (trade) => {
      setWalletDialogTrade(trade);
      setWalletDialogParticipants([]);
      setWalletDialogLoading(true);
      const list = await loadParticipantsForTrade(trade);
      setWalletDialogParticipants(list);
      setWalletDialogLoading(false);
    },
    [loadParticipantsForTrade]
  );

  const handleOpenBet = useCallback(
    async (trade) => {
      const key = trade.id || trade.trade_key;
      try {
        const url = await openTradePolymarketUrl(trade, alerts, polymarketUrls, (payload) =>
          base44.functions.invoke("resolve-polymarket-url", payload).then((res) => res.data)
        );
        if (url && key) {
          setPolymarketUrls((prev) => ({ ...prev, [key]: url }));
        } else {
          toast({
            title: "Polymarket link unavailable",
            description: "Could not find this market on Polymarket.",
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: "Polymarket link failed",
          description: "Try again in a moment.",
          variant: "destructive",
        });
      }
    },
    [alerts, polymarketUrls]
  );

  const runBacktest = useCallback(async () => {
    setBacktesting(true);
    try {
      const res = await base44.functions.invoke("backtest-strategies", {});
      const data = res.data || {};
      const allSummary = data.summary || [];
      const top = [...allSummary].sort((a, b) => (b.roi || 0) - (a.roi || 0))[0];
      const simulated = data.simulated || 0;
      toast({
        title: simulated > 0 ? "Backtest updated" : "Rankings refreshed",
        description: top
          ? `Best: ${top.name} — ${pct(top.roi)} return, ${top.resolved_trades} finished trades${
              simulated > 0 ? ` · ${simulated} new strategies tested` : ""
            }`
          : "Stats updated from saved trades",
      });
      await load();
      if (selectedId) await reloadTrades(selectedId);
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || String(err);
      toast({
        title: /rate limit/i.test(msg) ? "Slow down — try again in 2 min" : "Backtest failed",
        description: msg,
        variant: "destructive",
      });
      await load();
      if (selectedId) await reloadTrades(selectedId);
    } finally {
      setBacktesting(false);
    }
  }, [load, reloadTrades, selectedId]);

  const selected = strategies.find((s) => s.strategy_id === selectedId);
  const selectedParams = parseParams(selected);
  const stakePerTrade = selectedParams.stakeUsd || 100;

  const selectedTrades = useMemo(() => trades, [trades]);
  const backtestTrades = useMemo(() => selectedTrades.filter((t) => t.is_backtest), [selectedTrades]);
  const liveTrades = useMemo(() => selectedTrades.filter((t) => !t.is_backtest), [selectedTrades]);
  const backtestStats = useMemo(() => statsFromStrategyEntity(selected), [selected]);
  const liveStats = useMemo(() => statsFromTrades(liveTrades), [liveTrades]);
  const allStats = useMemo(() => combineStats(backtestStats, liveStats), [backtestStats, liveStats]);
  const confidence = useMemo(
    () => confidenceScore(allStats, liveStats),
    [allStats, liveStats]
  );

  const filteredTrades = useMemo(() => {
    let list = selectedTrades;
    if (tradeFilter === "finished") {
      list = list.filter((t) => t.status === "won" || t.status === "lost");
    } else if (tradeFilter === "open") {
      list = list.filter((t) => t.status === "open");
    } else if (tradeFilter === "live") {
      list = list.filter((t) => !t.is_backtest);
    } else if (tradeFilter === "past") {
      list = list.filter((t) => t.is_backtest);
    }
    return list;
  }, [selectedTrades, tradeFilter]);

  const globalDataRange = useMemo(() => {
    const liveR = tradeDateRange(liveTradesAll);
    const pastR = globalPastStart
      ? { start: new Date(globalPastStart), end: liveR?.end || new Date() }
      : null;
    return combineDateRange(pastR, liveR);
  }, [liveTradesAll, globalPastStart]);
  const pastRange = useMemo(() => tradeDateRange(backtestTrades), [backtestTrades]);
  const liveRange = useMemo(() => tradeDateRange(liveTrades), [liveTrades]);
  const allRange = useMemo(() => combineDateRange(pastRange, liveRange), [pastRange, liveRange]);

  const liveStatsByStrategy = useMemo(() => {
    const map = new Map();
    for (const t of liveTradesAll) {
      if (!map.has(t.strategy_id)) map.set(t.strategy_id, []);
      map.get(t.strategy_id).push(t);
    }
    const stats = new Map();
    for (const [id, list] of map) {
      stats.set(id, statsFromTrades(list));
    }
    return stats;
  }, [liveTradesAll]);

  const sortedStrategies = useMemo(() => {
    return [...strategies].sort((a, b) => {
      const aAll = allStatsForStrategy(a, liveStatsByStrategy);
      const bAll = allStatsForStrategy(b, liveStatsByStrategy);
      const aRoi = aAll.resolved > 0 ? Number(aAll.roi || 0) : -Infinity;
      const bRoi = bAll.resolved > 0 ? Number(bAll.roi || 0) : -Infinity;
      const aProven = aAll.resolved >= 30 ? 1 : 0;
      const bProven = bAll.resolved >= 30 ? 1 : 0;
      if (bProven !== aProven) return bProven - aProven;
      if (bRoi !== aRoi) return bRoi - aRoi;
      return bAll.resolved - aAll.resolved;
    });
  }, [strategies, liveStatsByStrategy]);

  const selectedTrust = trustLabel(allStats.resolved || 0);
  const selectedLiveSidebar = liveStatsByStrategy.get(selectedId);

  const best = useMemo(() => {
    const withData = strategies.filter((s) => allStatsForStrategy(s, liveStatsByStrategy).resolved >= 5);
    if (!withData.length) return null;
    return [...withData].sort((a, b) => {
      const aAll = allStatsForStrategy(a, liveStatsByStrategy);
      const bAll = allStatsForStrategy(b, liveStatsByStrategy);
      return (bAll.roi || 0) - (aAll.roi || 0);
    })[0];
  }, [strategies, liveStatsByStrategy]);

  const bestAllStats = best ? allStatsForStrategy(best, liveStatsByStrategy) : null;

  return (
    <div className="space-y-6 w-full">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <FlaskConical className="w-6 h-6 text-primary" />
            Strategy lab
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Fake money only · Big % = all-time (past + live)
            {globalDataRange && <> · Trades from {formatRange(globalDataRange)}</>}
          </p>
          <p className="text-muted-foreground text-xs mt-1">
            Live paper only started ~2 days ago; past replay is limited to synced wallet history (grows toward 30 days)
          </p>
        </div>
        <Button onClick={runBacktest} disabled={backtesting}>
          {backtesting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          Run full backtest
        </Button>
      </div>

      {best && bestAllStats && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Trophy className="w-4 h-4 text-emerald-600" />
              Best all-time
            </CardTitle>
            <CardDescription>
              {best.name} — {usd(bestAllStats.staked)} bet → {usd(bestAllStats.pnl)} profit (
              {pct(bestAllStats.roi)} all-time, {bestAllStats.resolved} finished)
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-3 xl:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Strategies</CardTitle>
            <CardDescription className="text-xs">
              Ranked by all-time % (past + live)
              {globalDataRange && <> · {formatRange(globalDataRange)}</>}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : strategies.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground px-4">
                <TrendingUp className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p>No strategies yet.</p>
              </div>
            ) : (
              <div className="divide-y max-h-[640px] overflow-y-auto">
                {sortedStrategies.map((s, i) => {
                  const isSelected = selectedId === s.strategy_id;
                  const hasTrades = (s.total_trades || 0) > 0;
                  const params = parseParams(s);
                  const gradeLabel = strategyGradeLabel(params);
                  const liveSidebar = liveStatsByStrategy.get(s.strategy_id);
                  const pastStats = statsFromStrategyEntity(s);
                  const allForStrategy = combineStats(pastStats, liveSidebar || statsFromTrades([]));
                  const trust = trustLabel(allForStrategy.resolved || 0);
                  const openTotal = (pastStats.open || 0) + (liveSidebar?.open || 0);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSelectedId(s.strategy_id)}
                      className={cn(
                        "w-full text-left px-4 py-3 transition-colors border-l-4",
                        isSelected
                          ? "bg-primary/10 border-l-primary"
                          : "border-l-transparent hover:bg-muted/50",
                        !hasTrades && "opacity-60"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {i === 0 && hasTrades && allForStrategy.resolved >= 5 && (allForStrategy.roi || 0) > 0 && (
                              <Trophy className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                            )}
                            <p className={cn("font-medium text-sm", isSelected && "text-primary")}>
                              {s.name}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                            <p className="text-xs text-muted-foreground">
                              {!hasTrades
                                ? "No signals"
                                : `${allForStrategy.resolved} done · ${openTotal} open`}
                            </p>
                            {trust.text !== "Proven" && allForStrategy.resolved < 30 && (
                              <Badge variant="outline" className={cn("text-[10px] px-1 py-0 h-4", trust.className)}>
                                {trust.text}
                              </Badge>
                            )}
                            {allForStrategy.resolved >= 30 && (
                              <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-emerald-500/10 text-emerald-700 border-emerald-500/30">
                                Proven
                              </Badge>
                            )}
                            {gradeLabel && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-[10px] px-1 py-0 h-4",
                                  gradeLabel === "A" || gradeLabel === "A+"
                                    ? GRADE_STYLES.A
                                    : GRADE_STYLES.B
                                )}
                              >
                                {gradeLabel}
                              </Badge>
                            )}
                          </div>
                        </div>
                        {hasTrades && allForStrategy.resolved > 0 && (
                          <div className="text-right shrink-0">
                            <p
                              className={cn(
                                "text-sm font-semibold",
                                (allForStrategy.roi || 0) >= 0 ? "text-emerald-600" : "text-red-600"
                              )}
                              title="All-time return (past + live) — use this to compare"
                            >
                              {pct(allForStrategy.roi)}
                            </p>
                            {pastStats.resolved > 0 && (
                              <p className="text-[10px] text-muted-foreground" title="Past test only">
                                past {pct(pastStats.roi)}
                              </p>
                            )}
                            {liveSidebar?.resolved > 0 && (
                              <p className="text-[10px] text-muted-foreground" title="Live paper only">
                                fwd {pct(liveSidebar.roi)}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {selected && (
          <div className="lg:col-span-9 xl:col-span-9 space-y-4 min-w-0">
            <Card className="border-primary/30">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>{selected.name}</CardTitle>
                    <CardDescription>{describeStrategy(selectedParams)}</CardDescription>
                  </div>
                  <Badge variant="outline" className={cn("text-xs", selectedTrust.className)}>
                    {selectedTrust.text}
                    {allStats.resolved ? ` · ${allStats.resolved} finished all-time` : ""}
                  </Badge>
                </div>
              </CardHeader>
            </Card>

            <PerformanceSummary
              pastStats={backtestStats}
              liveStats={liveStats}
              allStats={allStats}
              confidence={confidence}
              stakePerTrade={stakePerTrade}
              pastRange={pastRange}
              liveRange={liveRange}
              allRange={allRange}
            />

            <div className="grid gap-4 xl:grid-cols-2">
              <StatsDashboard
                title="Past test"
                hint={`${backtestStats.resolved} replayed trades from synced wallet history`}
                variant="past"
                stats={backtestStats}
                stakePerTrade={stakePerTrade}
                dateRange={pastRange}
              />
              <StatsDashboard
                title="Live paper"
                hint={`${liveStats.resolved} forward trades since live paper began`}
                variant="live"
                stats={liveStats}
                stakePerTrade={stakePerTrade}
                dateRange={liveRange}
              />
            </div>

            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">Trade history</CardTitle>
                    <CardDescription>
                      Click the blue <strong>See wallets</strong> button on any row (or click the row itself)
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { id: "finished", label: "Finished" },
                      { id: "open", label: "Open" },
                      { id: "live", label: "Live" },
                      { id: "past", label: "Past" },
                      { id: "all", label: "All" },
                    ].map(({ id, label }) => (
                      <Button
                        key={id}
                        size="sm"
                        variant={tradeFilter === id ? "default" : "outline"}
                        onClick={() => setTradeFilter(id)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0 pb-2">
                <TradeTable
                  trades={filteredTrades.slice(0, 100)}
                  alerts={alerts}
                  polymarketUrls={polymarketUrls}
                  onViewWallets={openWalletDialog}
                  onOpenBet={handleOpenBet}
                  loadingTradeKey={loadingTradeKey}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <Dialog
        open={!!walletDialogTrade}
        onOpenChange={(open) => {
          if (!open) setWalletDialogTrade(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Wallets that triggered this trade</DialogTitle>
            <DialogDescription>
              {walletDialogTrade?.market_title || "Market"} · bet on {walletDialogTrade?.outcome || "—"} ·{" "}
              {walletDialogTrade?.wallet_count || "—"} skilled wallets agreed
            </DialogDescription>
          </DialogHeader>
          {walletDialogLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ParticipantsList participants={walletDialogParticipants} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
