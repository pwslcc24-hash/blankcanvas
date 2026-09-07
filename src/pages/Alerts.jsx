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
import {
  Bell,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  X,
} from "lucide-react";

function usd(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function cents(price) {
  if (price == null || !Number.isFinite(Number(price))) return "—";
  return `${(Number(price) * 100).toFixed(1)}¢`;
}

function timeAgo(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const QUALITY_STYLES = {
  strong: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  caution: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  blocked: "bg-red-500/10 text-red-600 border-red-500/20",
};

const QUALITY_ICONS = {
  strong: ShieldCheck,
  caution: ShieldAlert,
  blocked: ShieldX,
};

import { polymarketUrlFromSlug } from "@/lib/polymarketLinks";

export default function Alerts() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [showExpired, setShowExpired] = useState(false);

  const loadAlerts = useCallback(async () => {
    try {
      const data = await base44.entities.ConsensusAlert.list("-detected_at", 200);
      setAlerts(data);
    } catch (err) {
      toast({
        title: "Failed to load alerts",
        description: err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  const scanForConsensus = useCallback(async () => {
    setScanning(true);
    try {
      const res = await base44.functions.invoke("detect-consensus", {});
      const { groupsFound, created, updated } = res.data || {};
      toast({
        title: `Scan complete`,
        description: `${groupsFound || 0} signal(s) found (${created || 0} new, ${updated || 0} updated)`,
      });
      await loadAlerts();
    } catch (err) {
      toast({
        title: "Consensus scan failed",
        description: err?.response?.data?.error || err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setScanning(false);
    }
  }, [loadAlerts]);

  const dismissAlert = useCallback(
    async (id) => {
      try {
        await base44.entities.ConsensusAlert.update(id, { status: "dismissed" });
        await loadAlerts();
      } catch (err) {
        toast({
          title: "Could not dismiss",
          description: err?.message || String(err),
          variant: "destructive",
        });
      }
    },
    [loadAlerts]
  );

  const visible = alerts.filter((a) => showExpired || a.status === "active");
  const strongCount = alerts.filter((a) => a.status === "active" && a.quality === "strong").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Bell className="w-6 h-6 text-primary" />
            Consensus alerts
          </h1>
          <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
            Fires when 3+ A/B wallets (medium+ confidence) buy the same outcome within 6 hours.
            Strong signals pass slow-market and price-drift filters — still paper-trade before real money.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowExpired((v) => !v)}>
            {showExpired ? "Hide expired" : "Show expired"}
          </Button>
          <Button onClick={scanForConsensus} disabled={scanning}>
            {scanning ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Scan now
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Active alerts</CardDescription>
            <CardTitle className="text-3xl">
              {alerts.filter((a) => a.status === "active").length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Strong (actionable)</CardDescription>
            <CardTitle className="text-3xl text-emerald-600">{strongCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last scan</CardDescription>
            <CardTitle className="text-lg font-medium">
              {alerts[0]?.detected_at ? timeAgo(alerts[0].detected_at) : "Not yet"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Signals</CardTitle>
          <CardDescription>
            Sorted newest first. Only &quot;strong&quot; signals meet all research filters — treat others as watch-only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : visible.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Bell className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>No consensus signals yet.</p>
              <p className="text-sm mt-1">Run a scan or wait for the next scheduled sync.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quality</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Wallets</TableHead>
                  <TableHead className="text-right">Entry</TableHead>
                  <TableHead className="text-right">Now</TableHead>
                  <TableHead className="text-right">Drift</TableHead>
                  <TableHead>Detected</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((alert) => {
                  const Icon = QUALITY_ICONS[alert.quality] || ShieldAlert;
                  let participants = [];
                  try {
                    participants = JSON.parse(alert.participants_json || "[]");
                  } catch {
                    participants = [];
                  }
                  return (
                    <TableRow key={alert.id} className={alert.status !== "active" ? "opacity-50" : ""}>
                      <TableCell>
                        <Badge variant="outline" className={QUALITY_STYLES[alert.quality] || ""}>
                          <Icon className="w-3 h-3 mr-1" />
                          {alert.quality}
                        </Badge>
                        {alert.block_reason && alert.quality !== "strong" && (
                          <p className="text-xs text-muted-foreground mt-1 max-w-[140px]">{alert.block_reason}</p>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        <p className="font-medium truncate" title={alert.market_title}>
                          {alert.market_title || alert.condition_id?.slice(0, 12)}
                        </p>
                        <a
                          href={polymarketUrlFromSlug(alert.market_slug) || "https://polymarket.com"}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
                        >
                          View market <ExternalLink className="w-3 h-3" />
                        </a>
                      </TableCell>
                      <TableCell>{alert.outcome || `#${alert.outcome_index}`}</TableCell>
                      <TableCell className="text-right font-medium">{alert.wallet_count}</TableCell>
                      <TableCell className="text-right">{cents(alert.vwap_entry_price)}</TableCell>
                      <TableCell className="text-right">{cents(alert.current_price)}</TableCell>
                      <TableCell className="text-right">
                        {alert.price_drift != null ? (
                          <span className={alert.price_drift > 0.02 ? "text-red-600" : "text-emerald-600"}>
                            {alert.price_drift >= 0 ? "+" : ""}
                            {(alert.price_drift * 100).toFixed(1)}¢
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">{timeAgo(alert.detected_at)}</TableCell>
                      <TableCell>
                        {alert.status === "active" && (
                          <Button variant="ghost" size="icon" onClick={() => dismissAlert(alert.id)} title="Dismiss">
                            <X className="w-4 h-4" />
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

      {visible.some((a) => a.participants_json) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How to read this</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>
              <strong className="text-foreground">Strong</strong> = 3+ skilled wallets agree, slow market, price hasn&apos;t run away (&lt;2¢ drift).
            </p>
            <p>
              <strong className="text-foreground">Caution</strong> = consensus exists but price moved 2–5¢ — edge may be gone.
            </p>
            <p>
              <strong className="text-foreground">Blocked</strong> = fast/crypto market or &gt;5¢ drift — do not copy.
            </p>
            <p>
              Next step after you trust signals: paper-trade for 30–60 days before any real money.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
