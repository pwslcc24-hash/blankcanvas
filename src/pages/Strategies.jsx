import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { FlaskConical, Loader2, RefreshCw, Trophy, TrendingUp } from "lucide-react";

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

function StatsDashboard({ title, hint, variant, stats, stakePerTrade }) {
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
            {variant === "live" ? "Forward test" : "30-day replay"}
          </Badge>
        </div>
        <CardDescription>{hint}</CardDescription>
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

function TradeTable({ trades }) {
  if (!trades.length) {
    return <p className="text-sm text-muted-foreground px-6 py-8 text-center">No trades in this view.</p>;
  }

  return (
    <div className="w-full overflow-x-auto">
      <Table className="min-w-[1100px] w-full">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[130px]">Entered</TableHead>
            <TableHead className="w-[130px]">Finished</TableHead>
            <TableHead className="min-w-[220px]">Market</TableHead>
            <TableHead className="w-[100px]">Bet</TableHead>
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
            return (
              <TableRow key={t.id}>
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
                  <p className="text-xs text-muted-foreground">
                    {t.wallet_count} wallets
                    {!t.is_backtest && " · live"}
                  </p>
                </TableCell>
                <TableCell className="text-sm">{t.outcome || "—"}</TableCell>
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
                  {t.pnl_usd != null ? (
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
  const [loading, setLoading] = useState(true);
  const [backtesting, setBacktesting] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [tradeFilter, setTradeFilter] = useState("finished");

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        base44.entities.PaperStrategy.list("-roi", 50),
        base44.entities.PaperTrade.list("-entry_at", 500),
      ]);
      setStrategies(s);
      setTrades(t);
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

  useEffect(() => {
    load();
  }, [load]);

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
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || String(err);
      toast({
        title: /rate limit/i.test(msg) ? "Slow down — try again in 2 min" : "Backtest failed",
        description: msg,
        variant: "destructive",
      });
      await load();
    } finally {
      setBacktesting(false);
    }
  }, [load]);

  const selected = strategies.find((s) => s.strategy_id === selectedId);
  const selectedParams = parseParams(selected);
  const stakePerTrade = selectedParams.stakeUsd || 100;

  const selectedTrades = useMemo(
    () => trades.filter((t) => t.strategy_id === selectedId),
    [trades, selectedId]
  );
  const backtestTrades = useMemo(() => selectedTrades.filter((t) => t.is_backtest), [selectedTrades]);
  const liveTrades = useMemo(() => selectedTrades.filter((t) => !t.is_backtest), [selectedTrades]);
  const backtestStats = useMemo(() => statsFromTrades(backtestTrades), [backtestTrades]);
  const liveStats = useMemo(() => statsFromTrades(liveTrades), [liveTrades]);

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

  const sortedStrategies = useMemo(() => {
    return [...strategies].sort((a, b) => {
      const aHas = (a.total_trades || 0) > 0 ? 1 : 0;
      const bHas = (b.total_trades || 0) > 0 ? 1 : 0;
      if (bHas !== aHas) return bHas - aHas;
      return (b.roi || 0) - (a.roi || 0);
    });
  }, [strategies]);

  const proven = strategies.filter((s) => (s.resolved_trades || 0) >= 5);
  const best = proven.length
    ? [...proven].sort((a, b) => (b.roi || 0) - (a.roi || 0))[0]
    : null;

  return (
    <div className="space-y-6 w-full">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <FlaskConical className="w-6 h-6 text-primary" />
            Strategy lab
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Fake money only · Past test = history replay · Live paper = new trades going forward
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

      {best && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Trophy className="w-4 h-4 text-emerald-600" />
              Best past test
            </CardTitle>
            <CardDescription>
              {best.name} — {usd(best.total_staked_usd)} bet → {usd(best.total_pnl_usd)} profit (
              {pct(best.roi)})
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-3 xl:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Strategies</CardTitle>
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
                            {i === 0 && hasTrades && (s.resolved_trades || 0) >= 5 && (
                              <Trophy className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                            )}
                            <p className={cn("font-medium text-sm", isSelected && "text-primary")}>
                              {s.name}
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {!hasTrades
                              ? "No signals"
                              : `${s.resolved_trades || 0} done · ${s.open_trades || 0} open`}
                          </p>
                        </div>
                        {hasTrades && (s.resolved_trades || 0) > 0 && (
                          <p
                            className={cn(
                              "text-sm font-semibold shrink-0",
                              (s.roi || 0) >= 0 ? "text-emerald-600" : "text-red-600"
                            )}
                          >
                            {pct(s.roi)}
                          </p>
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
                <CardTitle>{selected.name}</CardTitle>
                <CardDescription>{describeStrategy(selectedParams)}</CardDescription>
              </CardHeader>
            </Card>

            <div className="grid gap-4 xl:grid-cols-2">
              <StatsDashboard
                title="Past test"
                hint="Last 30 days replayed"
                variant="past"
                stats={backtestStats}
                stakePerTrade={stakePerTrade}
              />
              <StatsDashboard
                title="Live paper"
                hint="New trades since deploy — watch this"
                variant="live"
                stats={liveStats}
                stakePerTrade={stakePerTrade}
              />
            </div>

            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">Trade history</CardTitle>
                    <CardDescription>$0 back = loss · — = still open</CardDescription>
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
                <TradeTable trades={filteredTrades.slice(0, 100)} />
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
