import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";
import { AlertTriangle, ExternalLink, Loader2, Plus } from "lucide-react";

const CATEGORIES = ["OVERALL", "POLITICS", "SPORTS", "ESPORTS", "CRYPTO", "CULTURE", "ECONOMICS", "TECH", "FINANCE"];
const TIME_PERIODS = ["DAY", "WEEK", "MONTH", "ALL"];
const ORDER_BY = ["PNL", "VOL"];

function usd(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function Discover() {
  const [category, setCategory] = useState("OVERALL");
  const [timePeriod, setTimePeriod] = useState("ALL");
  const [orderBy, setOrderBy] = useState("PNL");
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [trackedAddresses, setTrackedAddresses] = useState(new Set());
  const [addingAddress, setAddingAddress] = useState(null);

  const loadTracked = useCallback(async () => {
    const wallets = await base44.entities.TrackedWallet.list(null, 5000, 0, ["address"]);
    setTrackedAddresses(new Set(wallets.map((w) => w.address)));
  }, []);

  const loadLeaderboard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke("polymarket-leaderboard", {
        category,
        timePeriod,
        orderBy,
        limit: 50,
      });
      setEntries(res.data?.entries || []);
    } catch (err) {
      toast({
        title: "Failed to load leaderboard",
        description: err?.response?.data?.error || err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [category, timePeriod, orderBy]);

  useEffect(() => {
    loadTracked();
  }, [loadTracked]);

  useEffect(() => {
    loadLeaderboard();
  }, [loadLeaderboard]);

  const trackWallet = useCallback(
    async (entry) => {
      const address = (entry.proxyWallet || entry.wallet || "").toLowerCase();
      if (!address) return;
      setAddingAddress(address);
      try {
        const wallet = await base44.entities.TrackedWallet.create({
          address,
          label: entry.userName || entry.user_name || undefined,
          source: orderBy === "VOL" ? "leaderboard_vol" : "leaderboard_pnl",
        });
        setTrackedAddresses((prev) => new Set(prev).add(address));
        base44.functions.invoke("sync-wallet", { walletId: wallet.id }).catch(() => {});
        toast({ title: `Now tracking ${entry.userName || shortAddress(address)}` });
      } catch (err) {
        toast({ title: "Failed to track wallet", description: err?.message || String(err), variant: "destructive" });
      } finally {
        setAddingAddress(null);
      }
    },
    [orderBy]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Discover wallets</h1>
        <p className="text-muted-foreground mt-1 max-w-2xl">
          Browse Polymarket's own leaderboard. This is a starting point for research, not a buy signal — a high
          all-time PnL can come from one lucky bet, and roughly 44% of "skilled" traders don't stay skilled
          out-of-sample. Review a wallet's history on its detail page before deciding whether to track it.
        </p>
      </div>

      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="py-4 flex items-start gap-3 text-sm text-amber-700">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p>
            Tracking a wallet here only starts syncing its activity for your own review — it never places trades or
            copies anything automatically.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={timePeriod} onValueChange={setTimePeriod}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TIME_PERIODS.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={orderBy} onValueChange={setOrderBy}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ORDER_BY.map((o) => (
              <SelectItem key={o} value={o}>Order by {o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Leaderboard</CardTitle>
          <CardDescription>Top 50 wallets, straight from Polymarket's public leaderboard API.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading leaderboard…
            </div>
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground text-sm py-8 text-center">No results.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rank</TableHead>
                  <TableHead>Trader</TableHead>
                  <TableHead>PnL</TableHead>
                  <TableHead>Volume</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry, idx) => {
                  const address = (entry.proxyWallet || entry.wallet || "").toLowerCase();
                  const isTracked = trackedAddresses.has(address);
                  return (
                    <TableRow key={address || idx}>
                      <TableCell>{entry.rank || idx + 1}</TableCell>
                      <TableCell>
                        <div className="font-medium">{entry.userName || entry.user_name || shortAddress(address)}</div>
                        <div className="text-xs text-muted-foreground font-mono">{shortAddress(address)}</div>
                      </TableCell>
                      <TableCell className={Number(entry.pnl || 0) >= 0 ? "text-emerald-600" : "text-red-600"}>
                        {usd(entry.pnl)}
                      </TableCell>
                      <TableCell>{usd(entry.vol)}</TableCell>
                      <TableCell className="text-right space-x-1 whitespace-nowrap">
                        <Button variant="ghost" size="icon" asChild>
                          <a href={`https://polymarket.com/profile/${address}`} target="_blank" rel="noreferrer">
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        </Button>
                        {isTracked ? (
                          <Button variant="outline" size="sm" asChild>
                            <Link to={`/wallets/${address}`}>View</Link>
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => trackWallet(entry)}
                            disabled={addingAddress === address}
                          >
                            {addingAddress === address ? (
                              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                            ) : (
                              <Plus className="w-3.5 h-3.5 mr-1.5" />
                            )}
                            Track
                          </Button>
                        )}
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
