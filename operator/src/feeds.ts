/**
 * Feed normalization. Every event carries a stable id, UTC observation time, source links,
 * freshness and corroboration. Credentialed adapters run only here, never in the static site.
 */
export type Sport = "mma" | "nhl" | "nfl" | "nba" | "football" | "tennis";
export type Status = "live" | "final" | "scheduled" | "stale" | "unavailable";
export type Period = "regulation" | "overtime" | "shootout" | "extra-time" | "penalties" | "decision" | "finish" | null;
/**
 * Availability kinds. A withdrawal is someone out with no injury reported; "unknown-reason" is out
 * (or missing) with no reason in the source. Neither is ever shown as a confirmed injury.
 */
export type AvailabilityKind = "confirmed-injury" | "withdrawal" | "suspension" | "questionable" | "unknown-reason" | "available";
export type Availability = { id: string; eventId?: string; player: string; team: string; kind: AvailabilityKind; status: string; detail: string; source: string; observedUtc: string };
export type AvailabilityFeed = { status: "ok" | "unavailable"; reason?: string; reports: Availability[]; sources: string[] };
export type NormEvent = {
  id: string; sport: Sport; competition: string; startUtc: string; home: string; away: string;
  status: Status; score: [number, number] | null; decidedIn: Period;
  outcomeModel: "three-way" | "two-way";        // football has draws; the other five are two-way
  observedUtc: string; sources: string[]; freshnessSeconds: number; corroboratedBy: string[];
  availability: Availability[];
};
export const OUTCOME_MODEL: Record<Sport, "three-way" | "two-way"> = { football: "three-way", mma: "two-way", nhl: "two-way", nfl: "two-way", nba: "two-way", tennis: "two-way" };
/** Older than this, a live or scheduled observation is reported stale rather than current. */
export const STALE_AFTER: Record<Status, number> = { live: 120, scheduled: 6 * 3600, final: Infinity, stale: Infinity, unavailable: Infinity };

export function classify(raw: { state: string; observedUtc: string; startUtc: string }, now = Date.now()): { status: Status; freshnessSeconds: number } {
  const age = Math.max(0, Math.round((now - Date.parse(raw.observedUtc)) / 1000));
  const s = raw.state.toLowerCase();
  let status: Status = /cancel/.test(s) ? "unavailable" : /final|closed|complete|\bft\b|aet|ended/.test(s) ? "final" : /live|inprogress|in_progress|halftime|1h|2h|period|quarter|set/.test(s) ? "live" : /scheduled|created|not_started|ns|tbd/.test(s) ? "scheduled" : "unavailable";
  if (Number.isNaN(age)) status = "unavailable";
  else if (age > STALE_AFTER[status]) status = "stale";
  else if (status === "scheduled" && Date.parse(raw.startUtc) < now - 4 * 3600 * 1000) status = "stale"; // start passed with no update
  return { status, freshnessSeconds: age };
}

export function decidedIn(sport: Sport, marker: string | undefined): Period {
  const m = (marker ?? "").toLowerCase();
  if (!m) return null;
  if (sport === "football") return /pen/.test(m) ? "penalties" : /aet|extra/.test(m) ? "extra-time" : "regulation";
  if (sport === "nhl") return /so|shootout/.test(m) ? "shootout" : /ot|overtime/.test(m) ? "overtime" : "regulation";
  if (sport === "mma") return /dec/.test(m) ? "decision" : "finish";
  return /ot|overtime/.test(m) ? "overtime" : "regulation";
}

/** Free-text classifier for sources without structured status. Negated injury text is not an injury. */
export function availabilityKind(text: string): AvailabilityKind {
  const t = text.toLowerCase();
  const injuryStated = /injur|torn|fracture|strain|sprain|concussion|knock|hamstring|knee|ankle|shoulder|groin|calf|back\b|illness/.test(t) && !/no injury|not injury|non-injury|without injury/.test(t);
  if (/suspend|\bban\b|red card|yellow card/.test(t)) return "suspension";
  if (/withdr|pulled out|scratch|replaced on the card|walkover|personal|not injury related|rest\b/.test(t) && !injuryStated) return "withdrawal";
  if (/questionable|doubtful|day.to.day|probable|game.time/.test(t)) return "questionable";
  if (injuryStated || /injured reserve|\bir\b/.test(t)) return "confirmed-injury";
  if (/\bout\b|missing|inactive|unavailable/.test(t)) return "unknown-reason";
  return "available";
}

/**
 * Structured mapping for providers that publish a status plus a reason (Sportradar injuries
 * `status` + `desc`/`primary`, API-Sports injuries `type` + `reason`).
 */
export function availabilityFrom(status: string, reason: string): AvailabilityKind {
  const s = status.toLowerCase(), r = reason.toLowerCase().trim();
  if (/suspen|red card|yellow card/.test(r) || /suspen/.test(s)) return "suspension";
  if (/not injury related|personal|rest|coach|international duty|national team|family|load management/.test(r)) return "withdrawal";
  if (/questionable|doubtful|probable|day to day|day-to-day/.test(s)) return "questionable";
  if (!r || /^unknown|^undisclosed|^other$|^n\/a/.test(r)) return "unknown-reason";
  const k = availabilityKind(r);
  return k === "available" ? "confirmed-injury" : k; // a named body part or ailment under an "out" status is a reported injury
}

/** Merge observations of one event from several adapters; agreement adds corroboration. */
export function corroborate(primary: NormEvent, others: NormEvent[]): NormEvent {
  const key = (e: NormEvent) => `${e.startUtc.slice(0, 13)}|${e.home}|${e.away}`.toLowerCase();
  const agree = others.filter((o) => (o.id === primary.id || key(o) === key(primary)) && o.status === primary.status && JSON.stringify(o.score) === JSON.stringify(primary.score));
  return { ...primary, corroboratedBy: agree.flatMap((o) => o.sources) };
}

export interface FeedAdapter {
  name: string; needsKey: boolean; sports: Sport[];
  fetchEvents(sport: Sport, now?: number): Promise<NormEvent[]>;
  fetchAvailability(sport: Sport, now?: number): Promise<AvailabilityFeed>;
}

type Fetch = typeof fetch;
/** An upstream refusal (unlicensed endpoint, bad key, quota) surfaces as an explicit unavailable state. */
export class FeedError extends Error {}
async function getJson(f: Fetch, url: string, headers: Record<string, string>) {
  const r = await f(url, { headers });
  if (!r.ok) throw new FeedError(`upstream ${r.status} from ${new URL(url).host}${r.status === 401 || r.status === 403 ? " (endpoint not licensed for this key)" : ""}`);
  return r.json() as Promise<any>;
}
const iso = (now: number) => new Date(now).toISOString();
const ymd = (now: number, sep: string) => iso(now).slice(0, 10).replace(/-/g, sep);
const unavailable = (reason: string): AvailabilityFeed => ({ status: "unavailable", reason, reports: [], sources: [] });

/**
 * Sportradar. Documented routes use an access level segment (`trial` or `production`):
 *   NHL v7  /nhl/{access}/v7/en/games/{yyyy}/{mm}/{dd}/schedule.json, /nhl/{access}/v7/en/league/injuries.json
 *   NBA v8  /nba/{access}/v8/en/games/{yyyy}/{mm}/{dd}/schedule.json, /nba/{access}/v8/en/league/injuries.json
 *   NFL v7  /nfl/official/{access}/v7/en/games/current_week/schedule.json,
 *           /nfl/official/{access}/v7/en/seasons/{year}/{type}/{week}/injuries.json
 *   MMA v2  /mma/{access}/v2/en/schedules/{yyyy-mm-dd}/summaries.json
 *   Tennis v3 /tennis/{access}/v3/en/schedules/{yyyy-mm-dd}/summaries.json
 * The operator's contract must cover a paid analysis product.
 */
export function sportradarAdapter(key: string, f: Fetch = fetch, access: "trial" | "production" = "trial"): FeedAdapter {
  const B = "https://api.sportradar.com";
  const h = { "x-api-key": key, accept: "application/json" };
  const periods = (g: any): any[] => g.periods ?? g.scoring?.periods ?? [];
  const usGame = (sport: "nhl" | "nba" | "nfl", g: any, url: string, now: number): NormEvent => {
    const observedUtc = iso(now);
    const c = classify({ state: String(g.status ?? ""), observedUtc, startUtc: g.scheduled }, now);
    const hadOt = g.overtime === true || periods(g).some((p) => p.period_type === "overtime" || p.type === "overtime");
    const marker = sport === "nhl" && (g.shootout || periods(g).some((p) => p.period_type === "shootout" || p.type === "shootout")) ? "so" : hadOt ? "ot" : "reg";
    const hp = g.home_points ?? g.scoring?.home_points, ap = g.away_points ?? g.scoring?.away_points;
    return { id: `sportradar:${sport}:${g.id}`, sport, competition: sport.toUpperCase(), startUtc: new Date(g.scheduled).toISOString(), home: g.home?.name ?? g.home?.alias, away: g.away?.name ?? g.away?.alias,
      status: c.status, freshnessSeconds: c.freshnessSeconds, score: hp != null && ap != null ? [hp, ap] : null,
      decidedIn: c.status === "final" ? decidedIn(sport, marker) : null, outcomeModel: OUTCOME_MODEL[sport], observedUtc, sources: [url], corroboratedBy: [], availability: [] };
  };
  const summary = (sport: "mma" | "tennis", s: any, url: string, now: number): NormEvent => {
    const ev = s.sport_event ?? {}, st = s.sport_event_status ?? {};
    const comp = ev.competitors ?? [];
    const home = comp.find((c: any) => c.qualifier === "home") ?? comp[0] ?? {}, away = comp.find((c: any) => c.qualifier === "away") ?? comp[1] ?? {};
    const observedUtc = iso(now);
    const state = /cancel|postpon|abandon/.test(String(st.status)) ? "cancelled" : String(st.status ?? "");
    const c = classify({ state, observedUtc, startUtc: ev.start_time }, now);
    const method = String(st.method ?? st.match_status ?? "");
    return { id: `sportradar:${sport}:${ev.id}`, sport, competition: ev.sport_event_context?.competition?.name ?? (sport === "mma" ? "MMA" : "Tennis"), startUtc: new Date(ev.start_time).toISOString(),
      home: home.name, away: away.name, status: c.status, freshnessSeconds: c.freshnessSeconds,
      score: st.home_score != null && st.away_score != null ? [st.home_score, st.away_score] : null,
      decidedIn: c.status === "final" ? (sport === "mma" ? decidedIn("mma", method || "finish") : /walkover|retired|defaulted/.test(method) ? "finish" : "regulation") : null,
      outcomeModel: "two-way", observedUtc, sources: [url], corroboratedBy: [], availability: [] };
  };
  const injuryRows = (sport: Sport, j: any, url: string, now: number): Availability[] => (j.teams ?? []).flatMap((t: any) => (t.players ?? []).flatMap((p: any) => (p.injuries ?? []).map((inj: any) => {
    const status = String(inj.status ?? ""), reason = String(inj.desc ?? inj.primary ?? "");
    return { id: `sportradar:${sport}:injury:${inj.id ?? p.id + ":" + reason}`, player: p.full_name ?? p.name, team: t.name ?? t.market, kind: availabilityFrom(status, reason), status, detail: [reason, inj.comment].filter(Boolean).join(". "), source: url, observedUtc: inj.update_date ? new Date(inj.update_date).toISOString() : iso(now) } satisfies Availability;
  })));
  const nflWeek = async () => { const url = `${B}/nfl/official/${access}/v7/en/games/current_week/schedule.json`; return { url, j: await getJson(f, url, h) }; };
  return {
    name: "sportradar", needsKey: true, sports: ["nhl", "nba", "nfl", "mma", "tennis"],
    async fetchEvents(sport, now = Date.now()) {
      if (!key) return [];
      if (sport === "nhl" || sport === "nba") {
        const url = `${B}/${sport}/${access}/${sport === "nhl" ? "v7" : "v8"}/en/games/${ymd(now, "/")}/schedule.json`;
        return ((await getJson(f, url, h)).games ?? []).map((g: any) => usGame(sport, g, url, now));
      }
      if (sport === "nfl") { const { url, j } = await nflWeek(); return (j.week?.games ?? j.games ?? []).map((g: any) => usGame("nfl", g, url, now)); }
      if (sport === "mma" || sport === "tennis") {
        const url = `${B}/${sport}/${access}/${sport === "mma" ? "v2" : "v3"}/en/schedules/${ymd(now, "-")}/summaries.json`;
        return ((await getJson(f, url, h)).summaries ?? []).map((s: any) => summary(sport, s, url, now));
      }
      return [];
    },
    async fetchAvailability(sport, now = Date.now()) {
      if (!key) return unavailable("no Sportradar key configured");
      if (sport === "nhl" || sport === "nba") {
        const url = `${B}/${sport}/${access}/${sport === "nhl" ? "v7" : "v8"}/en/league/injuries.json`;
        return { status: "ok", reports: injuryRows(sport, await getJson(f, url, h), url, now), sources: [url] };
      }
      if (sport === "nfl") {
        const { j } = await nflWeek();
        const url = `${B}/nfl/official/${access}/v7/en/seasons/${j.season?.year ?? j.year}/${j.season?.type ?? j.type ?? "REG"}/${j.week?.sequence ?? j.week?.title}/injuries.json`;
        const w = await getJson(f, url, h);
        return { status: "ok", reports: injuryRows("nfl", w.week ?? w, url, now), sources: [url] };
      }
      if (sport === "tennis") {
        // Tennis publishes no injury list; withdrawals appear as walkovers and retirements on the match.
        const url = `${B}/tennis/${access}/v3/en/schedules/${ymd(now, "-")}/summaries.json`;
        const j = await getJson(f, url, h);
        const reports = (j.summaries ?? []).flatMap((s: any) => {
          const st = s.sport_event_status ?? {}, ms = String(st.match_status ?? "");
          if (!/walkover|retired/.test(ms)) return [];
          const loser = (s.sport_event?.competitors ?? []).find((c: any) => c.id !== st.winner_id);
          return [{ id: `sportradar:tennis:${s.sport_event?.id}:${ms}`, eventId: `sportradar:tennis:${s.sport_event?.id}`, player: loser?.name ?? "unknown", team: "", kind: ms === "walkover" ? "withdrawal" : "unknown-reason", status: ms,
            detail: ms === "walkover" ? "Walkover: withdrew before the match. The feed gives no reason, so this is not recorded as an injury." : "Retired during the match. The feed gives no reason.", source: url, observedUtc: iso(now) } satisfies Availability];
        });
        return { status: "ok", reports, sources: [url] };
      }
      if (sport === "mma") return unavailable("Sportradar MMA v2 publishes no injury or withdrawal endpoint; cancelled bouts show as unavailable events");
      return unavailable("not served by Sportradar in this companion");
    },
  };
}

const API_SPORTS_STATE: Record<string, string> = { TBD: "scheduled", NS: "scheduled", "1H": "live", HT: "live", "2H": "live", ET: "live", BT: "live", P: "live", SUSP: "live", INT: "live", LIVE: "live", FT: "final", AET: "final", PEN: "final", PST: "cancelled", CANC: "cancelled", ABD: "cancelled", AWD: "final", WO: "final" };
/** API-Sports football (fixtures + injuries for the EPL, league 39), licensed per plan. */
export function apiSportsAdapter(key: string, f: Fetch = fetch): FeedAdapter {
  const h = { "x-apisports-key": key };
  const season = (now: number) => new Date(now).getUTCFullYear() - (new Date(now).getUTCMonth() < 6 ? 1 : 0);
  return {
    name: "api-sports", needsKey: true, sports: ["football"],
    async fetchEvents(sport, now = Date.now()) {
      if (!key || sport !== "football") return [];
      const url = `https://v3.football.api-sports.io/fixtures?league=39&season=${season(now)}&from=${ymd(now - 3 * 86400_000, "-")}&to=${ymd(now + 10 * 86400_000, "-")}`;
      const j = await getJson(f, url, h);
      const observedUtc = iso(now);
      return (j.response ?? []).map((x: any) => {
        const short = String(x.fixture?.status?.short ?? "");
        const c = classify({ state: API_SPORTS_STATE[short] ?? short, observedUtc, startUtc: x.fixture.date }, now);
        return { id: `api-sports:football:${x.fixture.id}`, sport, competition: "English Premier League", startUtc: new Date(x.fixture.date).toISOString(), home: x.teams.home.name, away: x.teams.away.name,
          status: c.status, freshnessSeconds: c.freshnessSeconds, score: x.goals?.home != null ? [x.goals.home, x.goals.away] : null,
          decidedIn: c.status === "final" ? decidedIn("football", short) : null, outcomeModel: "three-way", observedUtc,
          sources: [url], corroboratedBy: [], availability: [] } satisfies NormEvent;
      });
    },
    async fetchAvailability(sport, now = Date.now()) {
      if (!key) return unavailable("no API-Sports key configured");
      if (sport !== "football") return unavailable("API-Sports is wired for football only");
      const url = `https://v3.football.api-sports.io/injuries?league=39&season=${season(now)}&date=${ymd(now, "-")}`;
      const j = await getJson(f, url, h);
      const reports = (j.response ?? []).map((x: any) => ({ id: `api-sports:football:injury:${x.player?.id}:${x.fixture?.id}`, eventId: x.fixture?.id ? `api-sports:football:${x.fixture.id}` : undefined,
        player: x.player?.name, team: x.team?.name, kind: availabilityFrom(String(x.player?.type ?? ""), String(x.player?.reason ?? "")), status: String(x.player?.type ?? ""), detail: String(x.player?.reason ?? ""), source: url,
        observedUtc: iso(now) } satisfies Availability));
      return { status: "ok", reports, sources: [url] };
    },
  };
}

export type FeedResponse = { sport: Sport; status: "ok" | "unavailable"; reason?: string; observedUtc: string; events: NormEvent[]; availability: AvailabilityFeed };

/** All configured feeds for a sport. With none configured, or every upstream failing, the answer is an explicit unavailable. */
export async function eventsFor(sport: Sport, adapters: FeedAdapter[], now = Date.now()): Promise<FeedResponse> {
  const observedUtc = iso(now);
  const usable = adapters.filter((a) => a.sports.includes(sport));
  if (!usable.length) return { sport, status: "unavailable", reason: "no licensed feed configured for " + sport, observedUtc, events: [], availability: unavailable("no licensed feed configured for " + sport) };
  const errs: string[] = [];
  const results = await Promise.all(usable.map((a) => a.fetchEvents(sport, now).catch((e) => { errs.push(`${a.name}: ${(e as Error).message}`); return [] as NormEvent[]; })));
  const avs = await Promise.all(usable.map((a) => a.fetchAvailability(sport, now).catch((e) => unavailable(`${a.name}: ${(e as Error).message}`))));
  const okAv = avs.filter((a) => a.status === "ok");
  const availability: AvailabilityFeed = okAv.length ? { status: "ok", reports: okAv.flatMap((a) => a.reports), sources: okAv.flatMap((a) => a.sources) } : unavailable(avs.map((a) => a.reason).filter(Boolean).join("; "));
  const base = results.find((r) => r.length);
  if (!base) return { sport, status: "unavailable", reason: errs.length ? errs.join("; ") : "configured feeds returned no events for this window", observedUtc, events: [], availability };
  const others = results.flat().filter((o) => !base.includes(o));
  const events = base.map((e) => ({ ...corroborate(e, others), availability: availability.reports.filter((r) => r.eventId === e.id) }));
  return { sport, status: "ok", observedUtc, events, availability };
}
