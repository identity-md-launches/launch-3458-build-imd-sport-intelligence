import { COMPANION_ORIGIN } from "./release";

export type Status = {
  checkout: { enabled: boolean; blockers: string[]; priceUnits: string; legUnits: string; recipients: { developer: string; research: string } | null };
  token: { address: string; verified: boolean };
  research: { activated: boolean; plannedRoles: number; distinctContributors: number; allocatedUnits: string; authorizedUnits: string; spentUnits: string };
  feeds: Record<string, boolean>;
};
const KEY = "imd-sport-session";
export const session = {
  get: () => sessionStorage.getItem(KEY) ?? "",
  set: (t: string) => sessionStorage.setItem(KEY, t),
  clear: () => sessionStorage.removeItem(KEY),
};
export async function api<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
  if (!COMPANION_ORIGIN) return { ok: false, status: 0, data: { error: "companion_not_configured" } as T };
  try {
    const r = await fetch(COMPANION_ORIGIN + path, { ...init, headers: { "content-type": "application/json", ...(session.get() ? { authorization: `Bearer ${session.get()}` } : {}), ...(init.headers ?? {}) } });
    return { ok: r.ok, status: r.status, data: (await r.json()) as T };
  } catch { return { ok: false, status: 0, data: { error: "companion_unreachable" } as T }; }
}
export const getStatus = () => api<Status>("/api/status");
