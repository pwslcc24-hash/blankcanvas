import React from "react";
import { AlertCircle } from "lucide-react";

export default function PlatformNotice({ compact = false }) {
  if (compact) {
    return (
      <p className="text-xs text-muted-foreground leading-relaxed">
        Tracks international Polymarket (polymarket.com) wallets. U.S. residents trade on{" "}
        <strong className="font-medium text-foreground">Polymarket US</strong> (separate app) — do
        not use a VPN. Paper results are not validated for real money.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex gap-3">
      <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
      <div className="text-sm space-y-1">
        <p className="font-medium text-foreground">International Polymarket only</p>
        <p className="text-muted-foreground leading-relaxed">
          This dashboard syncs wallets from <strong className="font-medium">polymarket.com</strong>{" "}
          (international). U.S. residents must use the regulated{" "}
          <strong className="font-medium">Polymarket US</strong> app — not a VPN on the
          international site. Markets, prices, and APIs may differ. Treat all strategy results as
          paper-only research until forward-tested for months.
        </p>
      </div>
    </div>
  );
}
