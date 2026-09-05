import React, { useCallback, useEffect, useState } from "react";
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

function timeAgo(iso) {
  if (!iso) return "Never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.round(diffMs / 3600000);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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

function moneyIn(trade) {
  return Number(trade.stake_usd || 0);
}

export default function Strategies() {
  const [strategies, setStrategies] = useState([]);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [backtesting, setBacktesting] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        base44.entities.PaperStrategy.list("-roi", 50),
        base44.entities.PaperTrade.list("-entry_at", 500),
      ]);
      setStrategies(s);
      setTrades(t);
      if (!selectedId && s.length) setSelectedId(s[0].strategy_id);
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
  const selectedTrades = trades.filter((t) => t.strategy_id === selectedId);
  const forwardTrades = selectedTrades.filter((t) => !t.is_backtest);
  const backtestTrades = selectedTrades.filter((t) => t.is_backtest);

  const resolved = strategies.filter((s) => (s.resolved_trades || 0) >= 5);
  const best = resolved.length
    ? [...resolved].sort((a, b) => (b.roi || 0) - (a.roi || 0))[0]
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
            Fake-trades 21 copy-trading rules to see which would make money. New alerts are paper-traded
            automatically every 30 minutes — no real money yet.
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
              Best so far (5+ finished trades)
            </CardTitle>
            <CardDescription>
              {best.name} — {pct(best.roi)} return, {pct(best.win_rate)} wins, {usd(best.total_pnl_usd)} profit
              on {best.resolved_trades} trades
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>All strategies</CardTitle>
            <CardDescription>Click one to see what it does and every fake trade.</CardDescription>
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
                {[...strategies]
                  .sort((a, b) => (b.roi || 0) - (a.roi || 0))
                  .map((s, i) => {
                    const isSelected = selectedId === s.strategy_id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedId(s.strategy_id)}
                        className={cn(
                          "w-full text-left px-4 py-3 transition-colors border-l-4",
                          isSelected
                            ? "bg-primary/10 border-l-primary"
                            : "border-l-transparent hover:bg-muted/50"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              {i === 0 && (s.resolved_trades || 0) >= 5 && (
                                <Trophy className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                              )}
                              <p className={cn("font-medium text-sm truncate", isSelected && "text-primary")}>
                                {s.name}
                              </p>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {s.resolved_trades || 0} finished · {(s.open_trades || 0) > 0 ? `${s.open_trades} open · ` : ""}
                              {pct(s.win_rate)} win rate
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p
                              className={cn(
                                "text-sm font-semibold",
                                (s.roi || 0) >= 0 ? "text-emerald-600" : "text-red-600"
                              )}
                            >
                              {pct(s.roi)}
                            </p>
                            <p className="text-xs text-muted-foreground">{usd(s.total_pnl_usd)}</p>
                          </div>
                        </div>
                        {(s.resolved_trades || 0) < 5 && (
                          <Badge variant="outline" className="text-xs mt-2">
                            too few trades to trust
                          </Badge>
                        )}
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
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">Per trade</p>
                    <p className="text-lg font-semibold">{usd(selectedParams.stakeUsd || 100)}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">Total put in</p>
                    <p className="text-lg font-semibold">{usd(selected.total_staked_usd)}</p>
                    <p className="text-xs text-muted-foreground">finished trades only</p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">Net profit/loss</p>
                    <p
                      className={cn(
                        "text-lg font-semibold",
                        (selected.total_pnl_usd || 0) >= 0 ? "text-emerald-600" : "text-red-600"
                      )}
                    >
                      {usd(selected.total_pnl_usd)}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">Return</p>
                    <p
                      className={cn(
                        "text-lg font-semibold",
                        (selected.roi || 0) >= 0 ? "text-emerald-600" : "text-red-600"
                      )}
                    >
                      {pct(selected.roi)}
                    </p>
                    <p className="text-xs text-muted-foreground">avg {usd(selected.avg_pnl_usd)}/trade</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  {forwardTrades.length > 0
                    ? `${forwardTrades.length} live paper trade(s) from new alerts since deploy.`
                    : "Live paper trades will appear here when new consensus alerts fire (every ~30 min)."}
                  {" "}
                  {backtestTrades.length > 0 && `${backtestTrades.length} past test trade(s) from the last 30 days.`}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Trade history</CardTitle>
                <CardDescription>
                  Every fake buy — when it entered, when it settled, money in vs money out.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                {selectedTrades.length === 0 ? (
                  <p className="text-sm text-muted-foreground px-6 py-8 text-center">
                    No trades for this strategy yet.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Entered</TableHead>
                        <TableHead>Resolved</TableHead>
                        <TableHead>Market</TableHead>
                        <TableHead>Bet</TableHead>
                        <TableHead className="text-right">
                          <span className="inline-flex items-center gap-1">
                            <ArrowDownLeft className="w-3 h-3" /> Put in
                          </span>
                        </TableHead>
                        <TableHead className="text-right">
                          <span className="inline-flex items-center gap-1">
                            <ArrowUpRight className="w-3 h-3" /> Got out
                          </span>
                        </TableHead>
                        <TableHead className="text-right">Profit/Loss</TableHead>
                        <TableHead>Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedTrades.slice(0, 50).map((t) => {
                        const out = moneyOut(t);
                        const statusLabel =
                          t.status === "won" ? "Won" : t.status === "lost" ? "Lost" : "Open";
                        return (
                          <TableRow key={t.id}>
                            <TableCell className="whitespace-nowrap text-sm">
                              <div>{formatWhen(t.entry_at)}</div>
                              <div className="text-xs text-muted-foreground">@ {cents(t.entry_price)}</div>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-sm">
                              {t.status === "open" ? (
                                <span className="text-amber-600">Still open</span>
                              ) : (
                                <>
                                  <div>{formatWhen(t.exit_at)}</div>
                                  <div className="text-xs text-muted-foreground">
                                    @ {cents(t.exit_price)}
                                  </div>
                                </>
                              )}
                            </TableCell>
                            <TableCell className="max-w-[180px]">
                              <p className="truncate text-sm" title={t.market_title}>
                                {t.market_title || "Unknown market"}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {t.wallet_count} wallets agreed
                                {!t.is_backtest && " · live paper"}
                              </p>
                            </TableCell>
                            <TableCell className="text-sm">{t.outcome || "—"}</TableCell>
                            <TableCell className="text-right text-sm">
                              {usd(moneyIn(t))}
                              {t.fee_usd ? (
                                <div className="text-xs text-muted-foreground">
                                  incl. {usd(t.fee_usd)} fee
                                </div>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {out != null ? usd(out) : "—"}
                            </TableCell>
                            <TableCell className="text-right text-sm font-medium">
                              {t.pnl_usd != null ? (
                                <span className={t.pnl_usd >= 0 ? "text-emerald-600" : "text-red-600"}>
                                  {t.pnl_usd >= 0 ? "+" : ""}
                                  {usd(t.pnl_usd)}
                                </span>
                              ) : (
                                "—"
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
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Will it keep trading?</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            <strong className="text-foreground">Yes.</strong> Every 30 minutes the system syncs wallets,
            finds new consensus alerts, and opens fake trades for all active strategies. You don&apos;t
            need to click anything — just check back here to see new rows under &quot;live paper&quot; trades.
          </p>
          <p>
            Past rows are from the 30-day backtest. New rows going forward are the real test of whether a
            strategy still works.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
