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

function timeAgo(iso) {
  if (!iso) return "Never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.round(diffMs / 3600000);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
        base44.entities.PaperTrade.filter({ is_backtest: true }, "-entry_at", 500),
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

  const selectedTrades = trades.filter((t) => t.strategy_id === selectedId);
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
            Paper-tests ~20 consensus variants on 30 days of synced history (delay, slippage, 1% fee).
            Rankings use <strong className="text-foreground">resolved trades only</strong> — open positions don&apos;t count yet.
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
              Current leader (≥5 resolved trades)
            </CardTitle>
            <CardDescription>
              {best.name} — {pct(best.roi)} ROI, {pct(best.win_rate)} win rate, {usd(best.total_pnl_usd)} PnL
              on {best.resolved_trades} trades
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Strategy leaderboard</CardTitle>
          <CardDescription>
            Click a row to see its paper trades. Strategies with fewer than 5 resolved trades are marked provisional.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : strategies.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <TrendingUp className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>No strategies yet. Run a backtest to compare variants.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Strategy</TableHead>
                  <TableHead className="text-right">Resolved</TableHead>
                  <TableHead className="text-right">Win rate</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">Total PnL</TableHead>
                  <TableHead className="text-right">Avg/trade</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...strategies]
                  .sort((a, b) => (b.roi || 0) - (a.roi || 0))
                  .map((s, i) => (
                    <TableRow
                      key={s.id}
                      className={`cursor-pointer ${selectedId === s.strategy_id ? "bg-secondary/60" : ""}`}
                      onClick={() => setSelectedId(s.strategy_id)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {i === 0 && (s.resolved_trades || 0) >= 5 && (
                            <Trophy className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                          )}
                          <div>
                            <p className="font-medium text-sm">{s.name}</p>
                            <p className="text-xs text-muted-foreground">{s.strategy_id}</p>
                          </div>
                          {(s.resolved_trades || 0) < 5 && (
                            <Badge variant="outline" className="text-xs">
                              provisional
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{s.resolved_trades || 0}</TableCell>
                      <TableCell className="text-right">{pct(s.win_rate)}</TableCell>
                      <TableCell className="text-right">
                        <span className={(s.roi || 0) >= 0 ? "text-emerald-600" : "text-red-600"}>
                          {pct(s.roi)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">{usd(s.total_pnl_usd)}</TableCell>
                      <TableCell className="text-right">{usd(s.avg_pnl_usd)}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {timeAgo(s.last_backtest_at)}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selectedId && selectedTrades.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Trades — {selectedId}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Entry</TableHead>
                  <TableHead className="text-right">Exit</TableHead>
                  <TableHead className="text-right">PnL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedTrades.slice(0, 30).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="max-w-[200px] truncate" title={t.market_title}>
                      {t.market_title || t.condition_id?.slice(0, 12)}
                    </TableCell>
                    <TableCell>{t.outcome}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          t.status === "won"
                            ? "text-emerald-600"
                            : t.status === "lost"
                              ? "text-red-600"
                              : ""
                        }
                      >
                        {t.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {t.entry_price != null ? `${(t.entry_price * 100).toFixed(1)}¢` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {t.exit_price != null ? `${(t.exit_price * 100).toFixed(0)}¢` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {t.pnl_usd != null ? (
                        <span className={t.pnl_usd >= 0 ? "text-emerald-600" : "text-red-600"}>
                          {usd(t.pnl_usd)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How to interpret this</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            This is <strong className="text-foreground">not proof of future profits</strong> — it&apos;s which rule-set
            would have worked on data we already have. Survivorship bias and limited history still apply.
          </p>
          <p>
            Pick strategies with ≥5 resolved trades and positive ROI, then watch them forward on the Alerts tab before
            risking real money.
          </p>
          <p>
            Execution assumes 30s delay, 1¢ slippage, and 1% fee unless the variant says otherwise.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
