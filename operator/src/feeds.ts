/**
 * Feed normalization. Every event carries a stable id, UTC observation time, source links,
 * freshness and corroboration. Credentialed adapters run only here, never in the static site.
 */
export type Sport = "mma" | "nhl" | "nfl" | "nba" | "football" | "tennis";
export type Status = "live" | "final" | "scheduled" | "stale" | "unavailable";
export type Period = "regulation" | "overtime" | "shootout" | "extra-time" | "penalties" | "decision" | "finish" | null;
export type Availability = { player: string; team: string; kind: "confirmed-injury" | "withdrawal" | "suspension" | "questionable" | "available"; detail: string; source: string; observedUtc: string };
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
  let status: Status = /final|closed|complete|ft|aet|ended/.test(s) ? "final" : /live|inprogress|in_progress|halftime|1h|2h|period|quarter|set/.test(s) ? "live" : /scheduled|created|not_started|ns|tbd/.test(s) ? "scheduled" : "unavailable";
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

/** A withdrawal is not an injury unless a source says so explicitly. */
export function availabilityKind(text: string): Availability["kind"] {
  const t = text.toLowerCase();
  if (/withdr|pulled out|scratch(ed)? .*personal|replaced on the card/.test(t) && !/injur/.test(t)) return "withdrawal";
  if (/suspend|ban/.test(t)) return "suspension";
  if (/questionable|doubtful|day-to-day|probable|game-time/.test(t)) return "questionable";
  if (/out|injur|ir\b|torn|fracture|strain|sprain|concussion/.test(t)) return "confirmed-injury";
  return "available";
}

/** Merge observations of one event from several adapters; agreement adds corroboration. */
export function corroborate(primary: NormEvent, others: NormEvent[]): NormEvent {
  const agree = others.filter((o) => o.id === primary.id && o.status === primary.status && JSON.stringify(o.score) === JSON.stringify(primary.score));
  return { ...primary, corroboratedBy: agree.flatMap((o) => o.sources) };
}

export interface FeedAdapter { name: string; needsKey: boolean; sports: Sport[]; fetchEvents(sport: Sport, now?: number): Promise<NormEvent[]> }

type Fetch = typeof fetch;
/** Sportradar (licensed; the operator's contract must cover paid analysis). */
export function sportradarAdapter(key: string, f: Fetch = fetch): FeedAdapter {
  const paths: Partial<Record<Sport, string>> = { nhl: "nhl/official/trial/v7/en/games/{d}/schedule.json", nba: "nba/trial/v8/en/games/{d}/schedule.json", nfl: "nfl/official/trial/v7/en/games/current_week/schedule.json" };
  return {
    name: "sportradar", needsKey: true, sports: ["nhl", "nba", "nfl"],
    async fetchEvents(sport, now = Date.now()) {
      if (!key || !paths[sport]) return [];
      const d = new Date(now).toISOString().slice(0, 10).replace(/-/g, "/");
      const url = `https://api.sportradar.com/${paths[sport]!.replace("{d}", d)}`;
      const r = await f(url, { headers: { "x-api-key": key } });
      if (!r.ok) return [];
      const j = (await r.json()) as { games?: any[]; week?: { games?: any[] } };
      const observedUtc = new Date(now).toISOString();
      return (j.games ?? j.week?.games ?? []).map((g) => {
        const c = classify({ state: g.status, observedUtc, startUtc: g.scheduled }, now);
        return { id: `sportradar:${sport}:${g.id}`, sport, competition: sport.toUpperCase(), startUtc: g.scheduled, home: g.home?.name, away: g.away?.name, status: c.status, freshnessSeconds: c.freshnessSeconds,
          score: g.home_points != null ? [g.home_points, g.away_points] : null, decidedIn: c.status === "final" ? decidedIn(sport, g.overtime ? "ot" : g.shootout ? "so" : "reg") : null,
          outcomeModel: OUTCOME_MODEL[sport], observedUtc, sources: [url.replace(/\?.*$/, "")], corroboratedBy: [], availability: [] } satisfies NormEvent;
      });
    },
  };
}
/** API-Sports (football / MMA / tennis endpoints, licensed per plan). */
export function apiSportsAdapter(key: string, f: Fetch = fetch): FeedAdapter {
  return {
    name: "api-sports", needsKey: true, sports: ["football"],
    async fetchEvents(sport, now = Date.now()) {
      if (!key || sport !== "football") return [];
      const url = `https://v3.football.api-sports.io/fixtures?league=39&season=${new Date(now).getUTCFullYear() - (new Date(now).getUTCMonth() < 6 ? 1 : 0)}&next=20`;
      const r = await f(url, { headers: { "x-apisports-key": key } });
      if (!r.ok) return [];
      const j = (await r.json()) as { response?: any[] };
      const observedUtc = new Date(now).toISOString();
      return (j.response ?? []).map((x) => {
        const c = classify({ state: x.fixture.status.short, observedUtc, startUtc: x.fixture.date }, now);
        return { id: `api-sports:football:${x.fixture.id}`, sport, competition: "English Premier League", startUtc: new Date(x.fixture.date).toISOString(), home: x.teams.home.name, away: x.teams.away.name,
          status: c.status, freshnessSeconds: c.freshnessSeconds, score: x.goals.home != null ? [x.goals.home, x.goals.away] : null,
          decidedIn: c.status === "final" ? decidedIn("football", x.fixture.status.short) : null, outcomeModel: "three-way", observedUtc,
          sources: ["https://v3.football.api-sports.io/fixtures"], corroboratedBy: [], availability: [] } satisfies NormEvent;
      });
    },
  };
}

/** All configured feeds for a sport; with none configured the answer is an explicit unavailable. */
export async function eventsFor(sport: Sport, adapters: FeedAdapter[], now = Date.now()): Promise<{ status: "ok" | "unavailable"; reason?: string; events: NormEvent[] }> {
  const usable = adapters.filter((a) => a.sports.includes(sport));
  if (!usable.length) return { status: "unavailable", reason: "no licensed feed configured for " + sport, events: [] };
  const results = await Promise.all(usable.map((a) => a.fetchEvents(sport, now).catch(() => [] as NormEvent[])));
  const [first, ...rest] = results;
  if (!results.some((r) => r.length)) return { status: "unavailable", reason: "configured feeds returned nothing", events: [] };
  const base = first.length ? first : rest.find((r) => r.length)!;
  return { status: "ok", events: base.map((e) => corroborate(e, results.flat().filter((o) => !base.includes(o)))) };
}
