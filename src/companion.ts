import { COMPANION_ORIGIN } from "./release";

export type Status = {
  checkout: { enabled: boolean; blockers: string[]; priceUnits: string; legUnits: string; recipients: { developer: string; research: string } | null };
  token: { address: string; verified: boolean };
  research: { activated: boolean; plannedRoles: number; distinctContributors: number; allocatedUnits: string; authorizedUnits: string; spentUnits: string };
  feeds: Record<string, boolean>;
};
const KEY = "imd-sport-session";
/** The session token is bound to the address that signed in; a different wallet never reuses it. */
export const session = {
  get: () => { try { return (JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as { token?: string }).token ?? ""; } catch { return ""; } },
  address: () => { try { return (JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as { address?: string }).address ?? ""; } catch { return ""; } },
  set: (token: string, address: string) => sessionStorage.setItem(KEY, JSON.stringify({ token, address: address.toLowerCase() })),
  clear: () => sessionStorage.removeItem(KEY),
};
export type FeedStatus = "live" | "final" | "scheduled" | "stale" | "unavailable";
export type FeedAvailability = { id: string; eventId?: string; player: string; team: string; kind: "confirmed-injury" | "withdrawal" | "suspension" | "questionable" | "unknown-reason" | "available"; status: string; detail: string; source: string; observedUtc: string };
export type FeedEvent = { id: string; sport: string; competition: string; startUtc: string; home: string; away: string; status: FeedStatus; score: [number, number] | null; decidedIn: string | null; outcomeModel: "three-way" | "two-way"; observedUtc: string; sources: string[]; freshnessSeconds: number; corroboratedBy: string[]; availability: FeedAvailability[] };
export type FeedResponse = { sport: string; status: "ok" | "unavailable"; reason?: string; observedUtc: string; events: FeedEvent[]; availability: { status: "ok" | "unavailable"; reason?: string; reports: FeedAvailability[]; sources: string[] } };
export async function api<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
  if (!COMPANION_ORIGIN) return { ok: false, status: 0, data: { error: "companion_not_configured" } as T };
  try {
    const r = await fetch(COMPANION_ORIGIN + path, { ...init, headers: { "content-type": "application/json", ...(session.get() ? { authorization: `Bearer ${session.get()}` } : {}), ...(init.headers ?? {}) } });
    return { ok: r.ok, status: r.status, data: (await r.json()) as T };
  } catch { return { ok: false, status: 0, data: { error: "companion_unreachable" } as T }; }
}
export const getStatus = () => api<Status>("/api/status");
