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
import {
  ArrowDownLeft,
  ArrowUpRight,
  FlaskConical,
  Loader2,
  RefreshCw,
  Trophy,
  TrendingUp,
} from "lucide-react";

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

function cents(price, status) {
  if (price == null || !Number.isFinite(Number(price))) return "—";
  if (status === "lost" && price === 0) return "0¢ (you lost)";
  if (status === "won" && price === 1) return "100¢ (you won)";
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
  const lines = [
    `Waits for ${params.minWallets}+ ${gradeLabel}${confLabel} to buy the same side within ${params.windowHours} hours.`,
    `Uses $${params.stakeUsd} per fake trade (${params.delaySec}s delay, ${(params.slippage * 100).toFixed(1)}¢ slippage, ${(params.feeRate * 100).toFixed(0)}% fee).`,
  ];
  if (params.minTotalUsdc) {
    lines.push(`Only trades when skilled wallets put $${params.minTotalUsdc}+ combined into the signal.`);
  }
  if (params.maxPriceDrift != null) {
    lines.push(`Skips signals if price moved more than ${(params.maxPriceDrift * 100).toFixed(0)}¢ from the average entry.`);
  }
  return lines.join(" ");
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

function MoneySummary({ title, subtitle, stats, stakePerTrade }) {
  if (stats.resolved === 0 && stats.open === 0) {
    return (
      <Card className="bg-muted/20">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{subtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No trades yet — this strategy didn&apos;t get any signals.</p>
        </CardContent>
      </Card>
    );
  }

  const profitable = (stats.pnl || 0) >= 0;

  return (
    <Card className={cn(title.includes("Live") ? "border-amber-500/30" : "border-blue-500/30")}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats.resolved > 0 ? (
          <div className="rounded-lg border bg-background p-4 space-y-2 text-sm">
            <p>
              <strong className="text-foreground">{stats.resolved} finished trades</strong>
              {" "}× {usd(stakePerTrade)} each ={" "}
              <strong className="text-foreground">{usd(stats.staked)} total bet</strong>
            </p>
            <p>
              You got back <strong className="text-foreground">{usd(stats.gotBack)}</strong>
              {" "}(your {usd(stats.staked)} back {profitable ? "plus" : "minus"}{" "}
              {usd(Math.abs(stats.pnl))} {profitable ? "profit" : "loss"}).
            </p>
            <p className={cn("font-semibold text-base", profitable ? "text-emerald-600" : "text-red-600")}>
              Net: {profitable ? "+" : ""}
              {usd(stats.pnl)} ({pct(stats.roi)} return)
            </p>
            <p className="text-xs text-muted-foreground">
              {stats.wins} wins · {stats.losses} losses · {pct(stats.winRate)} win rate
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No finished trades yet — {stats.open} still open.</p>
        )}
        {stats.open > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {stats.open} trade(s) still open — not counted in profit until they finish.
          </p>
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Entered</TableHead>
          <TableHead>Finished</TableHead>
          <TableHead>Market</TableHead>
          <TableHead>Bet</TableHead>
          <TableHead className="text-right">
            <span className="inline-flex items-center gap-1">
              <ArrowDownLeft className="w-3 h-3" /> Put in
            </span>
          </TableHead>
          <TableHead className="text-right">
            <span className="inline-flex items-center gap-1">
              <ArrowUpRight className="w-3 h-3" /> Got back
            </span>
          </TableHead>
          <TableHead className="text-right">Profit/Loss</TableHead>
          <TableHead>Result</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((t) => {
          const out = moneyOut(t);
          const statusLabel = t.status === "won" ? "Won" : t.status === "lost" ? "Lost" : "Open";
          return (
            <TableRow key={t.id}>
              <TableCell className="whitespace-nowrap text-sm">
                <div>{formatWhen(t.entry_at)}</div>
                <div className="text-xs text-muted-foreground">bought @ {cents(t.entry_price)}</div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm">
                {t.status === "open" ? (
                  <span className="text-amber-600">Waiting…</span>
                ) : (
                  <>
                    <div>{formatWhen(t.exit_at)}</div>
                    <div className="text-xs text-muted-foreground">settled @ {cents(t.exit_price, t.status)}</div>
                  </>
                )}
              </TableCell>
              <TableCell className="max-w-[180px]">
                <p className="truncate text-sm" title={t.market_title}>
                  {t.market_title || "Unknown market"}
                </p>
                <p className="text-xs text-muted-foreground">{t.wallet_count} wallets agreed</p>
              </TableCell>
              <TableCell className="text-sm">{t.outcome || "—"}</TableCell>
              <TableCell className="text-right text-sm">{usd(t.stake_usd)}</TableCell>
              <TableCell className="text-right text-sm">
                {t.status === "open" ? (
                  <span className="text-muted-foreground">pending</span>
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
                  <span className="text-muted-foreground">pending</span>
                )}
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn(
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
      const res = await base44.functions.invoke("backtest-strategies", { full: true });
      const data = res.data || {};
      const allSummary = data.summary || [];
      const top = [...allSummary].sort((a, b) => (b.roi || 0) - (a.roi || 0))[0];
      toast({
        title: "Backtest complete",
        description: top
          ? `Best: ${top.name} — ROI ${pct(top.roi)}, ${top.resolved_trades} resolved trades`
          : `${allSummary.length} strategies tested`,
      });
      await load();
    } catch (err) {
      toast({
        title: "Backtest failed",
        description: err?.response?.data?.error || err?.message || String(err),
        variant: "destructive",
      });
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
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <FlaskConical className="w-6 h-6 text-primary" />
            Strategy lab
          </h1>
          <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
            Fake money only. <strong className="text-foreground">Past test</strong> = last 30 days replayed.{" "}
            <strong className="text-foreground">Live paper</strong> = new trades from here on out.
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
              Best past test (5+ finished trades)
            </CardTitle>
            <CardDescription>
              {best.name} — bet {usd(best.total_staked_usd)}, got back{" "}
              {usd((best.total_staked_usd || 0) + (best.total_pnl_usd || 0))}, kept {usd(best.total_pnl_usd)} profit
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>All strategies</CardTitle>
            <CardDescription>Strategies with no signals yet are at the bottom.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : strategies.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground px-4">
                <TrendingUp className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p>No strategies yet. Run a backtest first.</p>
              </div>
            ) : (
              <div className="divide-y max-h-[520px] overflow-y-auto">
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
                            <p className={cn("font-medium text-sm truncate", isSelected && "text-primary")}>
                              {s.name}
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {!hasTrades
                              ? "No signals yet"
                              : `${s.resolved_trades || 0} finished · ${s.open_trades || 0} open`}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          {!hasTrades || (s.resolved_trades || 0) === 0 ? (
                            <p className="text-xs text-muted-foreground">—</p>
                          ) : (
                            <>
                              <p
                                className={cn(
                                  "text-sm font-semibold",
                                  (s.roi || 0) >= 0 ? "text-emerald-600" : "text-red-600"
                                )}
                              >
                                {pct(s.roi)}
                              </p>
                              <p className="text-xs text-muted-foreground">{usd(s.total_pnl_usd)} profit</p>
                            </>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {selected && (
          <div className="lg:col-span-3 space-y-4">
            <Card className="border-primary/40 ring-1 ring-primary/20">
              <CardHeader>
                <CardTitle>{selected.name}</CardTitle>
                <CardDescription className="text-foreground/80 leading-relaxed">
                  {describeStrategy(selectedParams)}
                </CardDescription>
              </CardHeader>
            </Card>

            <MoneySummary
              title="Past test (last 30 days)"
              subtitle="Replayed history — this is where the big profit numbers come from."
              stats={backtestStats}
              stakePerTrade={stakePerTrade}
            />

            <MoneySummary
              title="Live paper (since deploy)"
              subtitle="Real test going forward — watch this section over the next few weeks."
              stats={liveStats}
              stakePerTrade={stakePerTrade}
            />

            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">Trade history</CardTitle>
                    <CardDescription>
                      $0 got back = you lost that bet. Pending = market not finished yet.
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { id: "finished", label: "Finished only" },
                      { id: "open", label: "Open only" },
                      { id: "live", label: "Live paper" },
                      { id: "past", label: "Past test" },
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
              <CardContent className="p-0 overflow-x-auto">
                <TradeTable trades={filteredTrades.slice(0, 80)} />
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
