import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";
import { ArrowLeft, ExternalLink, Loader2, RefreshCw } from "lucide-react";

function usd(value, opts = {}) {
  const n = Number(value || 0);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2, ...opts });
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

const EVENT_BADGE = {
  TRADE: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  SPLIT: "bg-purple-500/10 text-purple-600 border-purple-500/20",
  MERGE: "bg-purple-500/10 text-purple-600 border-purple-500/20",
  REDEEM: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  REWARD: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  CONVERSION: "bg-slate-500/10 text-slate-600 border-slate-500/20",
};

export default function WalletDetail() {
  const { address } = useParams();
  const navigate = useNavigate();
  const [wallet, setWallet] = useState(null);
  const [activity, setActivity] = useState([]);
  const [positions, setPositions] = useState([]);
  const [score, setScore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [wallets, activityRows, positionRows, scoreRows] = await Promise.all([
        base44.entities.TrackedWallet.filter({ address }),
        base44.entities.WalletActivity.filter({ wallet_address: address }, "-occurred_at", 200),
        base44.entities.WalletPosition.filter({ wallet_address: address }, "-current_value_usd", 200),
        base44.entities.WalletScore.filter({ wallet_address: address }),
      ]);
      if (!wallets.length) {
        toast({ title: "Wallet not found", variant: "destructive" });
        navigate("/");
        return;
      }
      setWallet(wallets[0]);
      setActivity(activityRows);
      setPositions(positionRows);
      setScore(scoreRows[0] || null);
    } catch (err) {
      toast({ title: "Failed to load wallet", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [address, navigate]);

  useEffect(() => {
    load();
  }, [load]);

  const sync = useCallback(async () => {
    if (!wallet) return;
    setSyncing(true);
    try {
      await base44.functions.invoke("sync-wallet", { walletId: wallet.id });
      await load();
    } catch (err) {
      toast({
        title: "Sync failed",
        description: err?.response?.data?.error || err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  }, [wallet, load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading wallet…
      </div>
    );
  }

  if (!wallet) return null;

  const pnl = Number(wallet.all_time_pnl_usd || 0);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to="/">
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            Back to wallets
          </Link>
        </Button>
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{wallet.label || "Unlabeled wallet"}</h1>
            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
              <span className="font-mono">{wallet.address}</span>
              <a
                href={`https://polymarket.com/profile/${wallet.address}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
          <Button onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Sync now
          </Button>
        </div>
      </div>

      {wallet.last_sync_status === "error" && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="py-4 text-sm text-red-600">
            Last sync failed: {wallet.last_sync_error}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>All-time PnL</CardDescription>
            <CardTitle className={`text-xl ${pnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>{usd(pnl)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>All-time volume</CardDescription>
            <CardTitle className="text-xl">{usd(wallet.all_time_volume_usd)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Distinct markets</CardDescription>
            <CardTitle className="text-xl">{wallet.distinct_markets_synced || 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Activity synced</CardDescription>
            <CardTitle className="text-xl">{wallet.activity_count_synced || 0}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {score && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-base">
                  Skill score: {score.grade} ({Number(score.score).toFixed(0)}/100)
                </CardTitle>
                <CardDescription>
                  Confidence: {score.confidence} · based on {score.closed_market_count} closed market
                  {score.closed_market_count === 1 ? "" : "s"} in synced history · computed{" "}
                  {formatDate(score.computed_at)}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4 text-sm">
              <div>
                <div className="text-muted-foreground">Win rate (closed markets)</div>
                <div className="font-medium">{(Number(score.win_rate) * 100).toFixed(1)}%</div>
              </div>
              <div>
                <div className="text-muted-foreground">Return on capital</div>
                <div className={`font-medium ${Number(score.return_on_capital) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {(Number(score.return_on_capital) * 100).toFixed(1)}%
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Calibration edge</div>
                <div className={`font-medium ${Number(score.calibration_edge) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {Number(score.calibration_edge) >= 0 ? "+" : ""}
                  {(Number(score.calibration_edge) * 100).toFixed(1)} pts
                  <span className="text-xs text-muted-foreground ml-1">
                    ({score.calibrated_market_count} markets)
                  </span>
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Realized profit</div>
                <div className={`font-medium ${Number(score.realized_profit_usd) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {usd(score.realized_profit_usd)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Capital deployed</div>
                <div className="font-medium">{usd(score.buy_volume_usd)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Profit concentration</div>
                <div className="font-medium">
                  {(Number(score.profit_concentration) * 100).toFixed(0)}%
                  {Number(score.profit_concentration) > 0.5 && (
                    <span className="text-xs text-amber-600 ml-1">one win dominates</span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Activity span</div>
                <div className="font-medium">{Number(score.activity_span_days).toFixed(0)} days</div>
              </div>
              <div>
                <div className="text-muted-foreground">Out-of-sample markets</div>
                <div className="font-medium">{score.oos_closed_market_count}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Out-of-sample profit</div>
                <div className={`font-medium ${Number(score.oos_realized_profit_usd) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {usd(score.oos_realized_profit_usd)}
                  {score.oos_closed_market_count > 0 && (
                    <span className="text-xs text-muted-foreground ml-1">
                      ({(Number(score.oos_win_rate) * 100).toFixed(0)}% wins)
                    </span>
                  )}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-4">
              Calibration edge compares actual wins against the price the wallet paid — buying favorites at a high
              price and winning often scores near zero here, since that's the market being right, not skill.
              Out-of-sample metrics only count markets first traded after you started tracking this wallet — the
              honest forward-test signal. Scores from fewer than ~30 closed markets should be treated as provisional.
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="activity">
        <TabsList>
          <TabsTrigger value="activity">Activity ({activity.length})</TabsTrigger>
          <TabsTrigger value="positions">Open positions ({positions.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="activity">
          <Card>
            <CardContent className="pt-6">
              {activity.length === 0 ? (
                <p className="text-muted-foreground text-sm py-8 text-center">
                  No activity synced yet. Click "Sync now" above.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Market</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Size (USDC)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activity.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap text-sm">{formatDate(row.occurred_at)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={EVENT_BADGE[row.event_type] || ""}>
                            {row.event_type}
                            {row.side ? ` ${row.side}` : ""}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-xs truncate">
                          {row.market_slug ? (
                            <a
                              href={`https://polymarket.com/event/${row.market_slug}`}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline"
                              title={row.market_title}
                            >
                              {row.market_title}
                            </a>
                          ) : (
                            row.market_title || "—"
                          )}
                        </TableCell>
                        <TableCell>{row.outcome || "—"}</TableCell>
                        <TableCell>{row.price != null ? `$${Number(row.price).toFixed(3)}` : "—"}</TableCell>
                        <TableCell>{usd(row.usdc_size)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="positions">
          <Card>
            <CardContent className="pt-6">
              {positions.length === 0 ? (
                <p className="text-muted-foreground text-sm py-8 text-center">No open positions.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Avg price</TableHead>
                      <TableHead>Current price</TableHead>
                      <TableHead>Paid</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>PnL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {positions.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="max-w-xs truncate">
                          {p.market_slug ? (
                            <a
                              href={`https://polymarket.com/event/${p.market_slug}`}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline"
                              title={p.market_title}
                            >
                              {p.market_title}
                            </a>
                          ) : (
                            p.market_title || "—"
                          )}
                        </TableCell>
                        <TableCell>{p.outcome || "—"}</TableCell>
                        <TableCell>{Number(p.size || 0).toLocaleString()}</TableCell>
                        <TableCell>{p.avg_price != null ? `$${Number(p.avg_price).toFixed(3)}` : "—"}</TableCell>
                        <TableCell>{p.current_price != null ? `$${Number(p.current_price).toFixed(3)}` : "—"}</TableCell>
                        <TableCell>{usd(p.initial_value_usd)}</TableCell>
                        <TableCell>{usd(p.current_value_usd)}</TableCell>
                        <TableCell className={Number(p.cash_pnl_usd || 0) >= 0 ? "text-emerald-600" : "text-red-600"}>
                          {usd(p.cash_pnl_usd)}
                          {p.percent_pnl != null && (
                            <span className="text-xs text-muted-foreground ml-1">
                              ({Number(p.percent_pnl).toFixed(1)}%)
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
