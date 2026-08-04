import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Wallet,
  Plus,
  RefreshCw,
  Trash2,
  ExternalLink,
  Loader2,
  ArrowUpRight,
  ArrowDownRight,
  Calculator,
} from "lucide-react";

function usd(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function timeAgo(iso) {
  if (!iso) return "Never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const SYNC_STATUS_STYLES = {
  success: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  error: "bg-red-500/10 text-red-600 border-red-500/20",
  pending: "bg-amber-500/10 text-amber-600 border-amber-500/20",
};

const GRADE_STYLES = {
  A: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  B: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  C: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  D: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  F: "bg-red-500/10 text-red-600 border-red-500/20",
};

export default function Dashboard() {
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncingAll, setSyncingAll] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [syncingIds, setSyncingIds] = useState(new Set());
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);

  const loadWallets = useCallback(async () => {
    try {
      const data = await base44.entities.TrackedWallet.list("-created_date");
      setWallets(data);
    } catch (err) {
      toast({
        title: "Failed to load tracked wallets",
        description: err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWallets();
  }, [loadWallets]);

  const syncWallet = useCallback(
    async (wallet) => {
      setSyncingIds((prev) => new Set(prev).add(wallet.id));
      try {
        const res = await base44.functions.invoke("sync-wallet", { walletId: wallet.id });
        const updated = res.data?.wallet;
        if (updated) {
          setWallets((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
        }
      } catch (err) {
        toast({
          title: `Sync failed for ${wallet.label || shortAddress(wallet.address)}`,
          description: err?.response?.data?.error || err?.message || String(err),
          variant: "destructive",
        });
      } finally {
        setSyncingIds((prev) => {
          const next = new Set(prev);
          next.delete(wallet.id);
          return next;
        });
      }
    },
    []
  );

  const syncAll = useCallback(async () => {
    setSyncingAll(true);
    try {
      const runStartedAt = new Date().toISOString();
      let totalSynced = 0;
      let totalFailed = 0;
      let remaining = 1;
      let iterations = 0;
      while (remaining > 0 && iterations < 40) {
        iterations += 1;
        const res = await base44.functions.invoke("sync-batch", { runStartedAt });
        const { synced, failed, remaining: rem } = res.data || {};
        totalSynced += synced || 0;
        totalFailed += failed || 0;
        remaining = rem || 0;
        if (remaining > 0) await new Promise((r) => setTimeout(r, 3000));
      }
      toast({
        title: `Synced ${totalSynced} wallet(s)`,
        description: totalFailed ? `${totalFailed} failed` : undefined,
      });
      await loadWallets();
    } catch (err) {
      toast({
        title: "Bulk sync failed",
        description: err?.response?.data?.error || err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setSyncingAll(false);
    }
  }, [loadWallets]);

  const recomputeScores = useCallback(async () => {
    setScoring(true);
    try {
      const runStartedAt = new Date().toISOString();
      let totalScored = 0;
      let totalFailed = 0;
      let remaining = 1;
      let iterations = 0;
      while (remaining > 0 && iterations < 40) {
        iterations += 1;
        const res = await base44.functions.invoke("score-batch", { runStartedAt });
        const { scored, failed, remaining: rem } = res.data || {};
        totalScored += scored || 0;
        totalFailed += failed || 0;
        remaining = rem || 0;
      }
      toast({
        title: `Scored ${totalScored} wallet(s)`,
        description: totalFailed ? `${totalFailed} failed` : undefined,
      });
      await loadWallets();
    } catch (err) {
      toast({
        title: "Scoring failed",
        description: err?.response?.data?.error || err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setScoring(false);
    }
  }, [loadWallets]);

  const addWallet = useCallback(
    async (e) => {
      e.preventDefault();
      const address = newAddress.trim().toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(address)) {
        toast({ title: "Enter a valid 0x wallet address", variant: "destructive" });
        return;
      }
      setAdding(true);
      try {
        const existing = await base44.entities.TrackedWallet.filter({ address });
        if (existing.length) {
          toast({ title: "Already tracking this wallet" });
          setNewAddress("");
          setNewLabel("");
          return;
        }
        const wallet = await base44.entities.TrackedWallet.create({
          address,
          label: newLabel.trim() || undefined,
          source: "manual",
        });
        setWallets((prev) => [wallet, ...prev]);
        setNewAddress("");
        setNewLabel("");
        syncWallet(wallet);
      } catch (err) {
        toast({
          title: "Failed to add wallet",
          description: err?.message || String(err),
          variant: "destructive",
        });
      } finally {
        setAdding(false);
      }
    },
    [newAddress, newLabel, syncWallet]
  );

  const removeWallet = useCallback(async (wallet) => {
    if (!window.confirm(`Stop tracking ${wallet.label || shortAddress(wallet.address)}?`)) return;
    try {
      await base44.entities.TrackedWallet.delete(wallet.id);
      setWallets((prev) => prev.filter((w) => w.id !== wallet.id));
    } catch (err) {
      toast({ title: "Failed to remove wallet", description: err?.message || String(err), variant: "destructive" });
    }
  }, []);

  const totals = wallets.reduce(
    (acc, w) => {
      acc.value += Number(w.open_positions_value_usd || 0);
      acc.pnl += Number(w.open_positions_unrealized_pnl_usd || 0);
      acc.trades += Number(w.activity_count_synced || 0);
      return acc;
    },
    { value: 0, pnl: 0, trades: 0 }
  );

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Wallet Intelligence Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Track Polymarket wallets, sync their activity, and research them before deciding whether they're worth following.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link to="/discover">Find wallets on the leaderboard</Link>
          </Button>
          <Button variant="outline" onClick={recomputeScores} disabled={scoring || wallets.length === 0}>
            {scoring ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Calculator className="w-4 h-4 mr-2" />}
            Recompute scores
          </Button>
          <Button onClick={syncAll} disabled={syncingAll || wallets.length === 0}>
            {syncingAll ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Sync all
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Tracked wallets</CardDescription>
            <CardTitle className="text-2xl">{wallets.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Open positions value</CardDescription>
            <CardTitle className="text-2xl">{usd(totals.value)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Open positions unrealized PnL</CardDescription>
            <CardTitle className={`text-2xl ${totals.pnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              {usd(totals.pnl)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a wallet to track</CardTitle>
          <CardDescription>Paste any Polymarket wallet address (0x...). It will sync automatically.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={addWallet} className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="address" className="sr-only">Wallet address</Label>
              <Input
                id="address"
                placeholder="0x..."
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                required
              />
            </div>
            <div className="sm:w-56 space-y-1.5">
              <Label htmlFor="label" className="sr-only">Label</Label>
              <Input
                id="label"
                placeholder="Nickname (optional)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={adding}>
              {adding ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
              Track wallet
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tracked wallets</CardTitle>
          <CardDescription>
            Stats below come straight from Polymarket's public activity/positions/leaderboard data — no scoring or
            filtering has been applied yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading wallets…
            </div>
          ) : wallets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-2">
              <Wallet className="w-8 h-8 mb-1" />
              <p>No wallets tracked yet. Add one above, or browse the leaderboard to discover candidates.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Wallet</TableHead>
                  <TableHead>Skill score</TableHead>
                  <TableHead>All-time PnL</TableHead>
                  <TableHead>All-time volume</TableHead>
                  <TableHead>Open positions</TableHead>
                  <TableHead>Activity synced</TableHead>
                  <TableHead>Last sync</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wallets.map((wallet) => {
                  const isSyncing = syncingIds.has(wallet.id);
                  const pnl = Number(wallet.all_time_pnl_usd || 0);
                  return (
                    <TableRow key={wallet.id}>
                      <TableCell>
                        <Link to={`/wallets/${wallet.address}`} className="font-medium hover:underline">
                          {wallet.label || shortAddress(wallet.address)}
                        </Link>
                        <div className="text-xs text-muted-foreground">{shortAddress(wallet.address)}</div>
                      </TableCell>
                      <TableCell>
                        {wallet.skill_grade ? (
                          <div>
                            <Badge variant="outline" className={GRADE_STYLES[wallet.skill_grade] || ""}>
                              {wallet.skill_grade} · {Number(wallet.skill_score || 0).toFixed(0)}
                            </Badge>
                            {(wallet.score_confidence === "insufficient" || wallet.score_confidence === "low") && (
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {wallet.score_confidence === "insufficient" ? "too little data" : "low confidence"}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not scored</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className={pnl >= 0 ? "text-emerald-600" : "text-red-600"}>
                          {pnl >= 0 ? (
                            <ArrowUpRight className="w-3.5 h-3.5 inline mr-0.5" />
                          ) : (
                            <ArrowDownRight className="w-3.5 h-3.5 inline mr-0.5" />
                          )}
                          {usd(pnl)}
                        </span>
                      </TableCell>
                      <TableCell>{usd(wallet.all_time_volume_usd)}</TableCell>
                      <TableCell>
                        {wallet.open_positions_count || 0} · {usd(wallet.open_positions_value_usd)}
                      </TableCell>
                      <TableCell>{wallet.activity_count_synced || 0}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={SYNC_STATUS_STYLES[wallet.last_sync_status] || ""}>
                          {wallet.last_sync_status === "error" ? "Error" : timeAgo(wallet.last_synced_at)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right space-x-1 whitespace-nowrap">
                        <Button variant="ghost" size="icon" onClick={() => syncWallet(wallet)} disabled={isSyncing}>
                          {isSyncing ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RefreshCw className="w-4 h-4" />
                          )}
                        </Button>
                        <Button variant="ghost" size="icon" asChild>
                          <a
                            href={`https://polymarket.com/profile/${wallet.address}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => removeWallet(wallet)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
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
  );
}
