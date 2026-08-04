// Resolves the caller of a backend function to a Base44 client.
//
// Two accepted callers:
//  1. A logged-in app user (normal dashboard usage) — runs with their permissions.
//  2. An external scheduler (GitHub Actions cron) presenting the SYNC_SECRET —
//     runs with the service role so it works without a user session.
import { createClientFromRequest } from "npm:@base44/sdk";

export type ResolvedCaller =
  | { client: any; mode: "user" | "scheduler" }
  | { client: null; mode: "unauthorized" };

// Base44 project secrets are exposed to functions as environment variables.
function getSyncSecret(): string | null {
  try {
    return Deno.env.get("SYNC_SECRET") || null;
  } catch {
    return null;
  }
}

export async function resolveClient(req: Request): Promise<ResolvedCaller> {
  const base44 = createClientFromRequest(req);

  const syncSecret = getSyncSecret();
  const provided =
    req.headers.get("x-sync-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (syncSecret && provided && provided === syncSecret) {
    return { client: base44.asServiceRole, mode: "scheduler" };
  }

  const user = await base44.auth.me().catch(() => null);
  if (!user) {
    return { client: null, mode: "unauthorized" };
  }
  return { client: base44, mode: "user" };
}
