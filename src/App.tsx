import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import epl from "./data/epl.json";
import { Logo, SportArt } from "./art";
import { ConnectSheet, signIn, payLegs, reconcilePending, pendingHashes, short } from "./wallet";
import { COMPANION_ORIGIN, WALLETCONNECT_PROJECT_ID, TOKEN } from "./release";
import { api, getStatus, session, type Status, type FeedResponse, type FeedEvent, type FeedAvailability } from "./companion";

type M = { id: string; season: string; round: string; kickoffUtc: string; home: string; away: string; p: number[]; result: "H" | "D" | "A" | null; ft: number[] | null; eloHome: number; eloAway: number };
const HELD = epl.heldOut as M[];
const SNAP = epl.snapshot.fixtures as M[];
const F = epl.featured as M & { formHome: string; formAway: string; h2h: { id: string; kickoffUtc: string; home: string; away: string; ft: number[] | null }[] };
const ALL = [...HELD, ...SNAP];

const SPORTS = [
  { id: "football", name: "Football", league: "EPL pilot", adapter: "API-Sports (football), credentialed" },
  { id: "mma", name: "UFC / MMA", league: "UFC", adapter: "Sportradar MMA, credentialed" },
  { id: "nhl", name: "NHL", league: "NHL", adapter: "Sportradar NHL, credentialed" },
  { id: "nfl", name: "NFL", league: "NFL", adapter: "Sportradar NFL, credentialed" },
  { id: "nba", name: "NBA", league: "NBA", adapter: "Sportradar NBA, credentialed" },
  { id: "tennis", name: "Tennis", league: "ATP / WTA", adapter: "Sportradar Tennis, credentialed" },
] as const;
const FACTORS = ["Statistics", "Injuries", "News", "Weather", "Venue", "Experience versus youth", "Fatigue", "Tactics", "Opposition strength", "Style", "Odds as a market signal", "Historical patterns and unexpected factors"];

const pct = (x: number) => `${Math.round(x * 100)}%`;
const team = (t: string) => t.replace(/ (FC|AFC)$/, "").replace(/^AFC /, "");
const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dt = (iso: string) => `${date(iso)}, ${iso.slice(11, 16)} UTC`;
const RES = { H: "Home win", D: "Draw", A: "Away win" } as const;
const brierOf = (m: M) => m.result ? m.p.reduce((s, x, i) => s + (x - (i === "HDA".indexOf(m.result!) ? 1 : 0)) ** 2, 0) : null;
const SRC = epl.source;
const asOf = dt(epl.asOf);

function useRoute() {
  const [h, setH] = useState(location.hash.slice(1) || "/");
  useEffect(() => { const f = () => { setH(location.hash.slice(1) || "/"); window.scrollTo(0, 0); }; addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h.split("?")[0];
}
function useStatus() {
  const [s, setS] = useState<Status | null>(null); const [tried, setTried] = useState(!COMPANION_ORIGIN);
  useEffect(() => { if (COMPANION_ORIGIN) getStatus().then((r) => { if (r.ok) setS(r.data); setTried(true); }); }, []);
  return { status: s, tried };
}

/** Feed data for one sport from the companion's /api/feeds/:sport, requested when the view opens. */
function useFeed(sport: string) {
  const [st, setSt] = useState<{ state: "off" | "loading" | "ok" | "unavailable"; data?: FeedResponse; reason?: string }>({ state: COMPANION_ORIGIN ? "loading" : "off" });
  useEffect(() => {
    if (!COMPANION_ORIGIN) return;
    let live = true; setSt({ state: "loading" });
    api<FeedResponse>(`/api/feeds/${sport}`).then((r) => { if (!live) return; if (r.ok && r.data.status === "ok") setSt({ state: "ok", data: r.data }); else setSt({ state: "unavailable", data: r.ok ? r.data : undefined, reason: r.ok ? r.data.reason : "the companion service did not answer" }); });
    return () => { live = false; };
  }, [sport]);
  return st;
}
/** Private screen state belongs to one address on one chain; a change drops it and the session. */
function usePrivateScope() {
  const { address, chainId } = useAccount();
  const scope = address ? `${address.toLowerCase()}:${chainId}` : "";
  const prev = useRef(scope);
  useEffect(() => {
    if (address && session.address() && session.address() !== address.toLowerCase()) session.clear();
    if (prev.current && prev.current !== scope) session.clear();
    prev.current = scope;
  }, [scope, address]);
  return scope;
}

export function App() {
  const route = useRoute();
  const scope = usePrivateScope();
  const parts = route.split("/").filter(Boolean);
  useEffect(() => { const t = document.querySelector("main h1")?.textContent; if (t) document.title = `${t} · IMD Sport Intelligence`; }, [route]);
  let page;
  if (parts[0] === "sport") page = <SportView id={parts[1] ?? "football"} tab={parts[2] ?? "live"} />;
  else if (parts[0] === "match") page = <MatchPage id={decodeURIComponent(parts.slice(1).join("/"))} />;
  else if (parts[0] === "accuracy") page = <Accuracy />;
  else if (parts[0] === "account") page = <Account />;
  else if (parts[0] === "activation") page = <Activation />;
  else page = <Home />;
  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <header className="top">
        <a className="brand" href="#/" aria-label="IMD Sport Intelligence home"><Logo /><span>IMD Sport Intelligence</span></a>
        <nav className="topnav" aria-label="Main">
          <a href="#/accuracy" aria-current={parts[0] === "accuracy" ? "page" : undefined}>Accuracy</a>
          <a href="#/account" aria-current={parts[0] === "account" ? "page" : undefined}>History</a>
          <a href="#/activation" aria-current={parts[0] === "activation" ? "page" : undefined}>Status</a>
        </nav>
        <ConnectSheet />
      </header>
      <nav className="sports" aria-label="Sports">
        {SPORTS.map((s) => <a key={s.id} href={`#/sport/${s.id}`} aria-current={parts[1] === s.id ? "page" : undefined}>{s.name}</a>)}
      </nav>
      <main id="main" tabIndex={-1} key={scope}>{page}</main>
      <footer className="foot">
        <nav className="footnav" aria-label="More"><a href="#/accuracy">Accuracy report</a><a href="#/account">Prediction history and receipts</a><a href="#/activation">Status and activation</a></nav>
        <p>Sports analysis only. Nothing here is betting advice, a tip or a promise of winnings. Probabilities are estimates and are often wrong.</p>
        <p>Results data: <a href={SRC.repo}>openfootball/football.json</a> at commit <span className="mono">{SRC.commit.slice(0, 10)}</span> ({SRC.license}). Artwork and logo are original to this project.</p>
      </footer>
    </>
  );
}

function ProbBar({ p, labels, result }: { p: number[]; labels: string[]; result?: string | null }) {
  const cls = ["pb-h", "pb-d", "pb-a"];
  return (
    <div className="prob">
      <div className="pbar" aria-hidden="true">{p.map((x, i) => <span key={i} className={cls[i]} style={{ width: `${x * 100}%` }} />)}</div>
      <dl className="plegend">
        {p.map((x, i) => (
          <div key={i} className={result && "HDA"[i] === result ? "hit" : ""}>
            <dt>{labels[i]}</dt><dd className="num">{pct(x)}{result && "HDA"[i] === result ? <span className="tag">Result</span> : null}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Badge({ kind }: { kind: "final" | "live" | "scheduled" | "stale" | "unavailable" | "historical" }) {
  const t = { final: "Final", live: "Live", scheduled: "Scheduled", stale: "Stale", unavailable: "Unavailable", historical: "Historical" }[kind];
  return <span className={`badge b-${kind}`}>{t}</span>;
}

function MatchCard({ m, lead }: { m: M; lead?: boolean }) {
  return (
    <article className={lead ? "card lead" : "card"}>
      <div className="meta"><Badge kind="historical" /><Badge kind="final" /><span>English Premier League {m.season.replace("-", "/")}, {m.round}</span></div>
      <h2 className="fixture">
        <span>{team(m.home)}</span><span className="score num">{m.ft?.join("–")}</span><span>{team(m.away)}</span>
      </h2>
      <p className="muted small">Kick-off {dt(m.kickoffUtc)}. Pre-match probabilities from ratings that had seen only earlier matches.</p>
      <ProbBar p={m.p} labels={[`${team(m.home)} win`, "Draw", `${team(m.away)} win`]} result={m.result} />
      {lead && <a className="btn btn-gold" href={`#/match/${encodeURIComponent(m.id)}`}>Open the analysis</a>}
    </article>
  );
}

function Home() {
  const h = epl.metrics.heldOut;
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>Probabilities you can audit.</h1>
          <p className="lede">Sports analysis that shows its pre-match numbers next to what actually happened. No wagering, no tips.</p>
        </div>
        <MatchCard m={F} lead />
      </section>
      <section className="band">
        <h2>Scored on {h.model.n} held-out EPL matches</h2>
        <div className="stats">
          <div><span className="big num">{h.model.brier.toFixed(3)}</span><span className="muted">Brier score, model</span></div>
          <div><span className="big num muted2">{h.baseline.brier.toFixed(3)}</span><span className="muted">Brier score, frequency baseline</span></div>
          <div><span className="big num">{h.model.logLoss.toFixed(3)}</span><span className="muted">Log loss, model (baseline {h.baseline.logLoss.toFixed(3)})</span></div>
        </div>
        <p className="muted small">Lower is better. Season 2025/26, never seen in training or calibration. As of {asOf}. This pilot supports EPL claims only.</p>
        <a className="btn btn-blue" href="#/accuracy">See the accuracy report</a>
      </section>
      <section>
        <h2>Six sports, one standard</h2>
        <div className="grid">
          {SPORTS.map((s) => (
            <a key={s.id} className="sport" href={`#/sport/${s.id}`}>
              <SportArt sport={s.id} className="art" />
              <span className="sport-name">{s.name}</span>
              <span className="muted small">{s.id === "football" ? "EPL pilot: backtest, fixtures, previews" : `${s.league} views, waiting on a licensed feed`}</span>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

function snapshotStatus(m: M): "final" | "scheduled" | "stale" {
  if (m.result) return "final";
  return Date.parse(m.kickoffUtc) > Date.now() ? "scheduled" : "stale";
}

const NOW = Date.now();
const FUTURE = SNAP.filter((m) => !m.result && Date.parse(m.kickoffUtc) > NOW);
const PAST_NO_RESULT = SNAP.filter((m) => !m.result && Date.parse(m.kickoffUtc) <= NOW);
const SNAP_MONTH = new Date(epl.asOf).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const DECIDED: Record<string, string> = { regulation: "Regulation", overtime: "Overtime", shootout: "Shootout", "extra-time": "After extra time", penalties: "On penalties", decision: "By decision", finish: "By finish" };
const KIND: Record<FeedAvailability["kind"], string> = { "confirmed-injury": "Confirmed injury", withdrawal: "Withdrawal, no injury reported", suspension: "Suspension", questionable: "Questionable", "unknown-reason": "Out, reason not given", available: "Available" };
const age = (s: number) => (s < 90 ? `${s} s old` : s < 5400 ? `${Math.round(s / 60)} min old` : `${Math.round(s / 3600)} h old`);
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

function SportView({ id, tab }: { id: string; tab: string }) {
  const s = SPORTS.find((x) => x.id === id) ?? SPORTS[0];
  const { status } = useStatus();
  const feed = useFeed(s.id);
  const tabs = [["live", "Live scores"], ["upcoming", "Upcoming"], ["availability", "Injuries and availability"], ["previews", "Prediction previews"], ["research", "Research"]] as const;
  const isFb = s.id === "football";
  const finals = SNAP.filter((m) => m.result).slice(-10).reverse();
  const ev = feed.data?.events ?? [];
  const ok = feed.state === "ok";
  const headLine = ok ? `Licensed feed via the companion, observed ${dt(feed.data!.observedUtc)}.` : isFb ? `Fixtures and results from a dated public snapshot (${asOf}); no live feed is active.` : feed.state === "loading" ? "Checking the companion's licensed feed…" : "No licensed live feed is active in this release.";
  return (
    <>
      <div className="sport-head">
        <div>
          <h1>{s.name}</h1>
          <p className="muted">{s.league}. {headLine}</p>
        </div>
        <SportArt sport={s.id} className="art head-art" />
      </div>
      <div className="tabs" role="tablist" aria-label={`${s.name} views`}>
        {tabs.map(([k, l]) => <a key={k} role="tab" aria-selected={tab === k} href={`#/sport/${s.id}/${k}`}>{l}</a>)}
      </div>
      <section className="panel" role="tabpanel">
        {tab === "live" && (ok ? <FeedList title="Live and recent" rows={ev.filter((e) => e.status !== "scheduled")} empty="No live or recent events in the feed window." /> : (
          <>
            <Unavailable what="Live scores" sport={s} feed={feed} />
            {isFb && <><h2>Latest results in the snapshot</h2><p className="muted small">Final scores recorded in the archive as of {asOf}. These are historical, not live.</p><FixtureList rows={finals} /></>}
          </>
        ))}
        {tab === "upcoming" && (ok ? <FeedList title="Upcoming" rows={ev.filter((e) => e.status === "scheduled")} empty="No scheduled events in the feed window." /> : isFb ? (
          <>
            {feed.state !== "off" && <Unavailable what="Upcoming events" sport={s} feed={feed} />}
            <h2>Scheduled in the {SNAP_MONTH} snapshot</h2>
            <p className="muted small">Kick-off times in UTC from the archive as of {asOf}. Dates can move after the snapshot; check the club before travelling.</p>
            <FixtureList rows={FUTURE.slice(0, 12)} />
            {PAST_NO_RESULT.length > 0 && <><h3>Archive: kick-off passed, no result in the snapshot</h3><p className="muted small">{PAST_NO_RESULT.length} fixtures are marked stale because the snapshot predates their results. The most recent are shown.</p><FixtureList rows={PAST_NO_RESULT.slice(-6).reverse()} /></>}
          </>
        ) : <Unavailable what="Upcoming events" sport={s} feed={feed} />)}
        {tab === "availability" && (ok && feed.data!.availability.status === "ok" ? <AvailabilityList feed={feed.data!} /> : (
          <>
            <Unavailable what="Injury and availability reports" sport={s} feed={feed} reason={feed.data?.availability.reason} />
            <p className="muted small">When active, each report states its kind: a confirmed injury, a withdrawal with no injury reported, an absence with no reason given, a suspension or a questionable status, each with its source and observation time.</p>
          </>
        ))}
        {tab === "previews" && (isFb ? <Previews rows={FUTURE.length ? FUTURE : PAST_NO_RESULT} /> : (
          <div className="empty"><h2>No validated model for {s.name} yet</h2><p className="muted">The only completed backtest is the EPL pilot, and it supports EPL claims only. {s.name} previews will appear after a backtest of the same kind and after research is activated.</p><a className="btn btn-blue" href="#/accuracy">See the EPL backtest</a></div>
        ))}
        {tab === "research" && <Research sport={s.id} status={status} />}
      </section>
    </>
  );
}

function Unavailable({ what, sport, feed, reason }: { what: string; sport: (typeof SPORTS)[number]; feed: ReturnType<typeof useFeed>; reason?: string }) {
  const why = reason ?? feed.reason;
  return (
    <div className="unavail" role="status">
      <Badge kind="unavailable" />
      <div>
        <strong>{what}: {feed.state === "loading" ? "checking the feed" : "unavailable"}</strong>
        <p className="muted small">{feed.state === "off" ? `Needs the operator's licensed feed (${sport.adapter}) behind the companion service. No unlicensed scraping is used.` : feed.state === "loading" ? "Asking the companion service." : `The companion reports: ${why ?? "no data"}. Historical records stay marked historical.`}</p>
      </div>
    </div>
  );
}

function FeedList({ title, rows, empty }: { title: string; rows: FeedEvent[]; empty: string }) {
  return (
    <>
      <h2>{title}</h2>
      {!rows.length ? <p className="muted">{empty}</p> : (
        <ul className="feed">
          {rows.map((e) => (
            <li key={e.id}>
              <div className="meta"><Badge kind={e.status} /><span>{e.competition}</span>{e.decidedIn && <span>{DECIDED[e.decidedIn] ?? e.decidedIn}</span>}<span>{e.outcomeModel === "three-way" ? "Draw possible" : "Two-way"}</span></div>
              <span className="fx-teams">{e.home} <span className="num">{e.score ? e.score.join("–") : "v"}</span> {e.away}</span>
              <span className="muted small">Starts {dt(e.startUtc)}. Observed {dt(e.observedUtc)}, {age(e.freshnessSeconds)}. {e.corroboratedBy.length ? `Corroborated by ${e.corroboratedBy.length} other source${e.corroboratedBy.length > 1 ? "s" : ""}.` : "Single source."}</span>
              <span className="small">Source: {e.sources.map((u) => <a key={u} href={u}>{host(u)}</a>)} · <span className="mono">{e.id}</span></span>
              {e.availability.length > 0 && <span className="small">{e.availability.map((a) => `${a.player}: ${KIND[a.kind]}`).join("; ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AvailabilityList({ feed }: { feed: FeedResponse }) {
  const r = feed.availability.reports;
  return (
    <>
      <h2>Injuries and availability</h2>
      <p className="muted small">From {feed.availability.sources.map((u) => host(u)).join(", ")}, read {dt(feed.observedUtc)}. A withdrawal is not an injury unless the source names one.</p>
      {!r.length ? <p className="muted">No reports in the feed right now.</p> : (
        <div className="scroll-x"><table className="tbl">
          <thead><tr><th scope="col">Player</th><th scope="col">Team</th><th scope="col">Kind</th><th scope="col">Source detail</th><th scope="col">Observed</th></tr></thead>
          <tbody>{r.map((a) => <tr key={a.id}><th scope="row">{a.player}</th><td>{a.team}</td><td>{KIND[a.kind]}</td><td>{[a.status, a.detail].filter(Boolean).join(": ")} <a href={a.source}>{host(a.source)}</a></td><td className="num">{dt(a.observedUtc)}</td></tr>)}</tbody>
        </table></div>
      )}
    </>
  );
}

function FixtureList({ rows }: { rows: M[] }) {
  if (!rows.length) return <p className="muted">No fixtures in the snapshot.</p>;
  return (
    <ul className="fixtures">
      {rows.map((m) => (
        <li key={m.id}>
          <a href={`#/match/${encodeURIComponent(m.id)}`}>
            <Badge kind={snapshotStatus(m)} />
            <span className="fx-teams">{team(m.home)} <span className="num">{m.ft ? m.ft.join("–") : "v"}</span> {team(m.away)}</span>
            <span className="muted small">{dt(m.kickoffUtc)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Previews({ rows }: { rows: M[] }) {
  return (
    <>
      <h2>{rows === FUTURE ? `Previews for fixtures scheduled in the ${SNAP_MONTH} snapshot` : "Model previews from the snapshot"}</h2>
      <p className="muted small">Free, historical-model previews: three outcomes, draws included, from Elo ratings frozen at {asOf}. They are not updated with later results, injuries or news, and stale fixtures stay marked stale.</p>
      <div className="previews">
        {rows.slice(0, 6).map((m) => (
          <article key={m.id} className="card">
            <div className="meta"><Badge kind={snapshotStatus(m)} /><span>{dt(m.kickoffUtc)}</span></div>
            <h3>{team(m.home)} v {team(m.away)}</h3>
            <ProbBar p={m.p} labels={["Home", "Draw", "Away"]} />
            <a href={`#/match/${encodeURIComponent(m.id)}`}>Open preview</a>
          </article>
        ))}
      </div>
    </>
  );
}

function Research({ sport, status }: { sport: string; status: Status | null }) {
  const name = SPORTS.find((s) => s.id === sport)!.name;
  return (
    <>
      <h2>{name} research plan</h2>
      <div className="stats">
        <div><span className="big num">36</span><span className="muted">planned roles for {name} (216 across six sports)</span></div>
        <div><span className="big num">{status ? status.research.distinctContributors : 0}</span><span className="muted">distinct contributors evidenced by accepted work</span></div>
        <div><span className="big num">{status?.research.activated ? "On" : "Off"}</span><span className="muted">research dispatch</span></div>
      </div>
      <p className="muted small">Each factor gets a researcher, an independent challenger who tests misleading statistics and contradictory evidence, and an adjudicator. Work runs on the IMD Swarm in budgeted waves once the operator activates research, and spend never exceeds the funded research balance. Planned roles are not contributors: the second figure counts only agents with accepted, hashed work.</p>
      <table className="tbl">
        <thead><tr><th scope="col">Factor</th><th scope="col">Research</th><th scope="col">Challenge</th><th scope="col">Adjudication</th></tr></thead>
        <tbody>{FACTORS.map((f) => <tr key={f}><th scope="row">{f}</th><td>Planned</td><td>Planned</td><td>Planned</td></tr>)}</tbody>
      </table>
    </>
  );
}

function MatchPage({ id }: { id: string }) {
  const m = ALL.find((x) => x.id === id) ?? F;
  const snap = m.season === epl.snapshot.season;
  const st = snapshotStatus(m);
  const b = brierOf(m);
  const fav = m.p.indexOf(Math.max(...m.p));
  const isF = m.id === F.id;
  const fileUrl = (SRC.files as Record<string, { url: string }>)[m.season].url;
  return (
    <>
      <div className="meta"><Badge kind="historical" /><Badge kind={st} /><span>English Premier League {m.season.replace("-", "/")}, {m.round}</span></div>
      <h1 className="fixture big-fix"><span>{team(m.home)}</span><span className="score num">{m.ft ? m.ft.join("–") : "v"}</span><span>{team(m.away)}</span></h1>
      <p className="muted">Kick-off {dt(m.kickoffUtc)}. {st === "stale" ? "The snapshot predates this fixture's result, so no result is shown." : st === "scheduled" ? "Scheduled in the snapshot." : `Final, ${RES[m.result!].toLowerCase()}, in 90 minutes (league match, no extra time).`}</p>
      <section className="card">
        <h2>Pre-match probabilities</h2>
        <ProbBar p={m.p} labels={[`${team(m.home)} win`, "Draw", `${team(m.away)} win`]} result={m.result} />
        <dl className="facts">
          <div><dt>Ratings before kick-off</dt><dd className="num">{team(m.home)} {m.eloHome}, {team(m.away)} {m.eloAway}</dd></div>
          <div><dt>Model favourite</dt><dd>{["Home win", "Draw", "Away win"][fav]} at {pct(m.p[fav])}</dd></div>
          {b !== null && <div><dt>Brier score for this match</dt><dd className="num">{b.toFixed(3)} (0 is perfect, 2 is worst)</dd></div>}
          {isF && <div><dt>Last five before kick-off</dt><dd className="mono">{team(m.home)} {F.formHome}, {team(m.away)} {F.formAway}</dd></div>}
        </dl>
      </section>
      <section className="card">
        <h2>Analysis</h2>
        <p>{m.result ? (m.result === "HDA"[fav]
          ? `The favourite came through. A ${pct(m.p[fav])} estimate means a result like this should happen about ${Math.round(m.p[fav] * 10)} times in 10; one match cannot confirm or refute it.`
          : `The model's favourite did not win. At ${pct(m.p["HDA".indexOf(m.result)])}, the actual result was given roughly a ${Math.round(m.p["HDA".indexOf(m.result)] * 10)} in 10 chance: an upset by the model's account, and the kind of miss the reliability bins in the accuracy report measure in aggregate.`)
          : "This is a preview from frozen ratings. It does not know team news, injuries or form after the snapshot date."}</p>
        <p className="muted small">The rating gap of {Math.abs(m.eloHome - m.eloAway)} points, plus a home advantage of {epl.model.params.HFA} points, sets the split. Draws come from a fitted band around even, which is why no side reaches very high certainty.</p>
        {isF && F.h2h.length > 0 && (<><h3>Earlier meetings in the archive</h3><ul className="plain">{F.h2h.map((h) => <li key={h.id}><span className="muted">{date(h.kickoffUtc)}</span> {team(h.home)} <span className="num">{h.ft?.join("–")}</span> {team(h.away)}</li>)}</ul></>)}
      </section>
      <section className="card">
        <h2>Premium synthesis</h2>
        <Checkout eventId={m.id} home={team(m.home)} away={team(m.away)} />
      </section>
      <section className="card">
        <h2>Source</h2>
        <dl className="facts">
          <div><dt>Event ID</dt><dd className="mono wrap">{m.id}</dd></div>
          <div><dt>Season file</dt><dd><a className="wrap" href={fileUrl}>{fileUrl}</a></dd></div>
          <div><dt>As of</dt><dd>{asOf} (archive commit date)</dd></div>
          <div><dt>Model</dt><dd>{epl.model.name}, version {epl.model.version}{snap ? ", ratings frozen at the snapshot" : ""}</dd></div>
        </dl>
      </section>
    </>
  );
}

type Version = { version: string; modelVersion: string; baseModel: string; cutoffUtc: string; outcomes: string[]; releasedAt: number; purchasable: boolean; entitled: boolean; intent: { id: string; status: string } | null };
type Intent = { id: string; legs: Record<"developer" | "research", { recipient: string; txHash?: string; verifiedAt?: number }> };
type Call = { to: string; data: string; leg: string };
type Synthesis = { release: { version: string; cutoffUtc: string; outcomes: string[]; probabilities: number[]; confidence: string; reasons: string[]; counterarguments: string[]; dataGaps: string[]; calibration: { temperature: number; n: number }; evidence: unknown[] } };
const LEG_NAME = { developer: "Developer", research: "Swarm research" } as const;

function SynthesisView({ s, home, away }: { s: Synthesis; home: string; away: string }) {
  const r = s.release;
  const labels = r.outcomes.length === 3 ? [`${home} win`, "Draw", `${away} win`] : [`${home} win`, `${away} win`];
  return (
    <div className="synth">
      <p className="ok-note" role="status">You own this prediction version. Reopening it never charges again. <a href="#/account">See your receipts</a></p>
      <ProbBar p={r.probabilities} labels={labels} />
      <dl className="facts">
        <div><dt>Confidence</dt><dd>{r.confidence}</dd></div>
        <div><dt>Evidence cutoff</dt><dd>{dt(r.cutoffUtc)}</dd></div>
        <div><dt>Calibration</dt><dd className="num">Temperature {r.calibration.temperature} fitted on {r.calibration.n} earlier forecasts</dd></div>
        <div><dt>Accepted Swarm work</dt><dd className="num">{r.evidence.length} records</dd></div>
      </dl>
      {r.reasons.length > 0 && <><h3>Reasons</h3><ul className="plain">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul></>}
      {r.counterarguments.length > 0 && <><h3>Counterarguments</h3><ul className="plain">{r.counterarguments.map((x) => <li key={x}>{x}</li>)}</ul></>}
      {r.dataGaps.length > 0 && <><h3>Data gaps</h3><ul className="plain">{r.dataGaps.map((x) => <li key={x}>{x}</li>)}</ul></>}
    </div>
  );
}

/**
 * Premium synthesis for one event. The companion lists the event's released versions; checkout
 * appears only for a purchasable completed version while the companion reports every prerequisite.
 */
function Checkout({ eventId, home = "Home", away = "Away" }: { eventId: string; home?: string; away?: string }) {
  const { address, isConnected } = useAccount();
  const [list, setList] = useState<{ state: "loading" | "ok" | "error"; versions: Version[]; checkout?: { enabled: boolean; blockers: string[] } }>({ state: "loading", versions: [] });
  const [step, setStep] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<{ version: string; intent: Intent; calls: Call[]; waiting: string[] } | null>(null);
  const [owned, setOwned] = useState<Synthesis | null>(null);
  const loadList = async () => {
    const r = await api<{ versions: Version[]; checkout: { enabled: boolean; blockers: string[] } }>(`/api/events/${encodeURIComponent(eventId)}/predictions`);
    if (!r.ok) return setList({ state: "error", versions: [] });
    setList({ state: "ok", versions: r.data.versions, checkout: r.data.checkout });
    const ent = r.data.versions.find((v) => v.entitled); if (ent) await openSynthesis(ent.version);
  };
  const openSynthesis = async (version: string) => {
    const r = await api<Synthesis>(`/api/predictions/${encodeURIComponent(version)}`);
    if (r.ok) { setOwned(r.data); setActive(null); setStep(""); } else setErr(r.status === 402 ? "The companion has not granted this version yet." : "The companion did not return the synthesis.");
  };
  /** Ask the companion for the bound intent (idempotent) and draw the next confirmation from its unpaid, not-pending legs. */
  const refresh = async (version: string) => {
    const res = await api<any>("/api/intents", { method: "POST", body: JSON.stringify({ predictionVersion: version }) });
    if (!res.ok) { setErr(res.data?.blockers?.join("; ") ?? res.data?.error ?? "This prediction version is not purchasable."); return null; }
    if (res.data.alreadyEntitled) { await openSynthesis(version); return null; }
    const intent = res.data.intent as Intent;
    const before = Object.keys(pendingHashes.get(intent.id)).length;
    const rec = await reconcilePending(intent.id);
    if (rec.errors.length) setErr(rec.errors.join("; "));
    if (rec.entitled) { await openSynthesis(version); return null; }
    if (rec.waiting.length < before) return refresh(version); // a leg settled: re-read the bound intent before drawing the next confirmation
    const calls = (res.data.calls as Call[]).filter((c) => !rec.waiting.includes(c.leg));
    const next = { version, intent, calls, waiting: rec.waiting };
    setActive(next); return next;
  };
  useEffect(() => { if (COMPANION_ORIGIN) loadList(); }, [eventId]);
  // Reopening a version with an open intent resumes it: pending hashes are re-verified before anything is asked.
  useEffect(() => { const v = list.versions.find((x) => x.intent && !x.entitled); if (v && session.get() && !active && !owned) refresh(v.version); }, [list.versions]);

  if (!COMPANION_ORIGIN) return (
    <div className="unavail" role="status"><Badge kind="unavailable" /><div><strong>Purchases are off in this release.</strong><p className="muted small">A premium synthesis costs 1 IMD per prediction version once the operator activates the companion service. No payment is requested here. <a href="#/activation">What needs activation</a></p></div></div>
  );
  if (owned) return <SynthesisView s={owned} home={home} away={away} />;
  if (list.state === "loading") return <p className="muted">Checking the companion service…</p>;
  if (list.state === "error") return <div className="unavail" role="status"><Badge kind="unavailable" /><div><strong>Purchases are unavailable.</strong><p className="muted small">The companion service did not answer. No payment is requested.</p></div></div>;
  const buyable = list.versions.filter((v) => v.purchasable);
  if (!buyable.length) return <div className="unavail" role="status"><Badge kind="unavailable" /><div><strong>No completed prediction version for this event.</strong><p className="muted small">A version is released after Swarm research, independent challenges and adjudication finish. No payment is requested.</p></div></div>;
  if (!list.checkout?.enabled) return <div className="unavail" role="status"><Badge kind="unavailable" /><div><strong>Purchases are paused.</strong><p className="muted small">The companion reports: {list.checkout?.blockers.join("; ")}.</p></div></div>;
  const run = (f: () => Promise<void>) => async () => { setErr(""); setBusy(true); try { await f(); } catch (e) { setErr((e as Error).message.split("\n")[0]); setStep(""); } finally { setBusy(false); } };
  const start = (version: string) => run(async () => {
    if (!address) return;
    if (!session.get()) { const e = await signIn(address); if (e) { setErr(e); return; } }
    await refresh(version);
  });
  const pay = run(async () => {
    if (!active || !address) return;
    try { await payLegs(active.intent.id, address, active.calls, setStep); }
    finally { const n = await refresh(active.version); setStep(n && n.waiting.length ? "Sent. Waiting for Ethereum finality before the transfer is verified; you will not be asked for it again." : ""); }
  });
  if (!isConnected) return <p className="muted">Connect a wallet and sign in to buy a prediction version for 1 IMD.</p>;
  if (!active) return (
    <>
      <ul className="plain">{buyable.map((v) => (
        <li key={v.version}>
          <p>Version <span className="mono wrap">{v.version}</span>, evidence cutoff {dt(v.cutoffUtc)}. 1 IMD, paid as two direct transfers from your wallet.</p>
          <button className="btn btn-gold" onClick={start(v.version)} disabled={busy}>{v.intent ? "Resume the purchase" : "Review the purchase"}</button>
        </li>
      ))}</ul>
      {err && <p className="note" role="alert">{err}</p>}
    </>
  );
  const legs = active.intent.legs;
  const state = (k: "developer" | "research") => legs[k].verifiedAt ? "Verified" : active.waiting.includes(k) ? "Sent, waiting for finality" : "To pay";
  return (
    <>
      <p className="small">Version <span className="mono wrap">{active.version}</span></p>
      <table className="tbl">
        <thead><tr><th scope="col">Leg</th><th scope="col">Recipient</th><th scope="col">Amount</th><th scope="col">State</th></tr></thead>
        <tbody>{(["developer", "research"] as const).map((k) => (
          <tr key={k}><th scope="row">{LEG_NAME[k]}</th><td className="mono wrap">{legs[k].recipient}</td><td className="num">0.5 IMD</td><td>{state(k)}{legs[k].txHash && <> · <a href={`https://etherscan.io/tx/${legs[k].txHash}`}>receipt</a></>}</td></tr>
        ))}</tbody>
      </table>
      <p className="muted small">Token: IMD on Ethereum Mainnet, <span className="mono wrap">{TOKEN.address}</span>. Network gas is paid separately to the network and is not part of the 1 IMD. If your wallet supports atomic batches you confirm once; otherwise you confirm two transfers, and if you stop after the first, the sent half is kept and you resume at the missing one.</p>
      {active.calls.length > 0 && <button className="btn btn-gold" onClick={pay} disabled={busy}>Pay {active.calls.length === 2 ? "1 IMD" : "the missing 0.5 IMD"}</button>}
      {active.waiting.length > 0 && <button className="btn btn-quiet" onClick={run(async () => { await refresh(active.version); })} disabled={busy}>Check the sent transfer again</button>}
      {step && <p className="muted" role="status">{step}</p>}
      {err && <p className="note" role="alert">{err}</p>}
    </>
  );
}

function Reliability({ which }: { which: "model" | "baseline" }) {
  const bins = (which === "model" ? epl.reliability.heldOut : epl.reliability.baselineHeldOut).filter((b) => b.n > 0);
  const W = 320, H = 320, P = 36, sx = (x: number) => P + x * (W - 2 * P), sy = (y: number) => H - P - y * (H - 2 * P);
  const maxN = Math.max(...bins.map((b) => b.n));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rel" role="img" aria-label={`Reliability diagram for the ${which}: predicted probability against observed frequency`}>
      <rect x={P} y={P} width={W - 2 * P} height={H - 2 * P} fill="#0d0f14" />
      {[0, 0.25, 0.5, 0.75, 1].map((t) => <g key={t}><path d={`M${sx(t)} ${sy(0)}V${sy(1)}M${sx(0)} ${sy(t)}H${sx(1)}`} stroke="#222630" /><text x={sx(t)} y={H - 14} textAnchor="middle" className="axis">{pct(t)}</text><text x={14} y={sy(t) + 4} className="axis">{pct(t)}</text></g>)}
      <path d={`M${sx(0)} ${sy(0)}L${sx(1)} ${sy(1)}`} stroke="#6b6f7a" strokeDasharray="4 4" />
      <polyline fill="none" stroke="#3d9bff" strokeWidth="2" points={bins.map((b) => `${sx(b.meanPredicted!)},${sy(b.observed!)}`).join(" ")} />
      {bins.map((b) => <circle key={b.lo} cx={sx(b.meanPredicted!)} cy={sy(b.observed!)} r={3 + 7 * Math.sqrt(b.n / maxN)} fill="#d9b45a" fillOpacity=".85"><title>{`${pct(b.lo)} to ${pct(b.hi)}: ${b.n} predictions, mean ${pct(b.meanPredicted!)}, observed ${pct(b.observed!)}`}</title></circle>)}
    </svg>
  );
}

function Accuracy() {
  const met = epl.metrics.heldOut;
  const [which, setWhich] = useState<"model" | "baseline">("model");
  const [q, setQ] = useState(""); const [res, setRes] = useState(""); const [sort, setSort] = useState("date");
  const teams = useMemo(() => [...new Set(HELD.flatMap((m) => [m.home, m.away]))].sort(), []);
  const rows = useMemo(() => {
    let r = HELD.filter((m) => (!q || m.home === q || m.away === q) && (!res || m.result === res));
    if (sort === "surprise") r = [...r].sort((a, b) => brierOf(b)! - brierOf(a)!);
    else r = [...r].reverse();
    return r;
  }, [q, res, sort]);
  const sub = rows.length ? rows.reduce((s, m) => s + brierOf(m)!, 0) / rows.length : 0;
  const bins = which === "model" ? epl.reliability.heldOut : epl.reliability.baselineHeldOut;
  const download = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(epl, null, 2)], { type: "application/json" })); a.download = "imd-sport-epl-backtest.json"; a.click(); };
  return (
    <>
      <h1>EPL accuracy report</h1>
      <p className="muted">A completed backtest on English Premier League results only. Source: <a href={SRC.repo}>openfootball/football.json</a>, commit <span className="mono">{SRC.commit.slice(0, 10)}</span>, {SRC.license}. As of {asOf}. Rebuild with <span className="mono">npm run backtest</span> to reproduce every number.</p>
      <table className="tbl">
        <caption>Held-out season 2025/26, {met.model.n} matches with results ({epl.splits.heldOut.excludedNoResult} fixtures had no result in the archive and are excluded)</caption>
        <thead><tr><th scope="col">Forecast</th><th scope="col">Matches</th><th scope="col">Brier</th><th scope="col">Log loss</th><th scope="col">Favourite won</th></tr></thead>
        <tbody>
          {([["Model, calibrated", met.model], ["Model, before calibration", met.modelUncalibrated], ["Frequency baseline", met.baseline]] as const).map(([l, x]) => (
            <tr key={l}><th scope="row">{l}</th><td className="num">{x.n}</td><td className="num">{x.brier.toFixed(4)}</td><td className="num">{x.logLoss.toFixed(4)}</td><td className="num">{pct(x.accuracy)}</td></tr>
          ))}
        </tbody>
      </table>
      <section>
        <h2>How it was run</h2>
        <ol className="steps">
          <li><strong>Training, {epl.splits.training.seasons.map((x) => x.replace("-", "/")).join(" and ")}:</strong> Elo ratings used all {epl.splits.training.matches} training results. Parameter selection scored {epl.splits.training.parameterSelection.matches}, excluding {epl.splits.training.parameterSelection.warmupRule.replace("1-8", "1–8").replace("2022-23", "2022/23")} ({epl.splits.training.parameterSelection.warmupExcluded} matches). Selected: update size K {epl.model.params.K}, home advantage {epl.model.params.HFA}, scale {epl.model.params.S}, draw band {epl.model.params.theta}.</li>
          <li><strong>Calibration, {epl.splits.calibration.seasons[0]}:</strong> {epl.splits.calibration.matches} later matches fit one temperature ({epl.model.temperature}) that softens over-confident splits.</li>
          <li><strong>Held-out evaluation, {epl.splits.heldOut.seasons[0]}:</strong> {epl.splits.heldOut.matches} matches scored once. Every probability used only results before its kick-off.</li>
          <li><strong>Baseline:</strong> home {pct(epl.baseline.p[0])}, draw {pct(epl.baseline.p[1])}, away {pct(epl.baseline.p[2])}, the outcome frequencies of the training and calibration seasons.</li>
        </ol>
      </section>
      <section className="rel-wrap">
        <div>
          <h2>Reliability</h2>
          <div className="seg" role="group" aria-label="Forecast shown">
            <button aria-pressed={which === "model"} onClick={() => setWhich("model")}>Model</button>
            <button aria-pressed={which === "baseline"} onClick={() => setWhich("baseline")}>Baseline</button>
          </div>
          <Reliability which={which} />
          <p className="muted small">Each dot is a 10-point bin of predicted probability, pooled over home, draw and away; its size is the count. On the dashed line, outcomes happen as often as forecast.</p>
        </div>
        <table className="tbl">
          <thead><tr><th scope="col">Bin</th><th scope="col">Count</th><th scope="col">Predicted</th><th scope="col">Observed</th></tr></thead>
          <tbody>{bins.map((b) => <tr key={b.lo}><th scope="row" className="num">{pct(b.lo)}–{pct(b.hi)}</th><td className="num">{b.n}</td><td className="num">{b.meanPredicted === null ? "none" : pct(b.meanPredicted)}</td><td className="num">{b.observed === null ? "none" : pct(b.observed)}</td></tr>)}</tbody>
        </table>
      </section>
      <section>
        <h2>Every held-out match</h2>
        <div className="filters">
          <label>Team<select value={q} onChange={(e) => setQ(e.target.value)}><option value="">All teams</option>{teams.map((t) => <option key={t} value={t}>{team(t)}</option>)}</select></label>
          <label>Result<select value={res} onChange={(e) => setRes(e.target.value)}><option value="">Any result</option><option value="H">Home win</option><option value="D">Draw</option><option value="A">Away win</option></select></label>
          <label>Order<select value={sort} onChange={(e) => setSort(e.target.value)}><option value="date">Newest first</option><option value="surprise">Biggest misses first</option></select></label>
          <button className="btn btn-quiet" onClick={download}>Download the backtest data</button>
        </div>
        <p className="muted small" role="status">{rows.length} matches, mean Brier {sub.toFixed(3)}.</p>
        <div className="scroll-x">
          <table className="tbl matches">
            <thead><tr><th scope="col">Date</th><th scope="col">Match</th><th scope="col">Home</th><th scope="col">Draw</th><th scope="col">Away</th><th scope="col">Result</th><th scope="col">Brier</th></tr></thead>
            <tbody>{rows.slice(0, 60).map((m) => (
              <tr key={m.id}><td className="num">{m.kickoffUtc.slice(0, 10)}</td><td><a href={`#/match/${encodeURIComponent(m.id)}`}>{team(m.home)} {m.ft?.join("–")} {team(m.away)}</a></td>
                {m.p.map((x, i) => <td key={i} className={"num" + ("HDA"[i] === m.result ? " hitcell" : "")}>{pct(x)}</td>)}<td>{RES[m.result!]}</td><td className="num">{brierOf(m)!.toFixed(3)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        {rows.length > 60 && <p className="muted small">Showing 60 of {rows.length}. Download the data for every row.</p>}
      </section>
    </>
  );
}

function Account() {
  const { address, isConnected } = useAccount();
  const [hist, setHist] = useState<any>(null); const [err, setErr] = useState("");
  const load = async () => { const r = await api<any>("/api/me/history"); if (r.ok) setHist(r.data); else setErr(r.status === 401 ? "Sign in to see your history." : "The companion service did not answer."); };
  useEffect(() => { if (COMPANION_ORIGIN && address && session.get() && session.address() === address.toLowerCase()) load(); }, [address]);
  return (
    <>
      <h1>Your predictions and receipts</h1>
      {!COMPANION_ORIGIN ? (
        <div className="unavail" role="status"><Badge kind="unavailable" /><div><strong>History is off in this release.</strong><p className="muted small">Signed-in prediction history and payment receipts are kept privately by the operator's companion service, never on IPFS or in this site's files. Nothing is stored in your browser beyond a session token. <a href="#/activation">What needs activation</a></p></div></div>
      ) : !isConnected ? <p className="muted">Connect a wallet, then sign in, to see only your own purchases.</p>
        : !hist ? <><button className="btn btn-gold" onClick={async () => { const e = await signIn(address!); if (e) setErr(e); else load(); }}>Sign in with Ethereum</button>{err && <p className="note" role="alert">{err}</p>}</>
        : hist.purchases.length === 0 ? <p className="muted">No purchases for {short(hist.address)} yet. Free analysis is on every match page.</p>
        : <table className="tbl"><thead><tr><th scope="col">Prediction version</th><th scope="col">State</th><th scope="col">Receipts</th></tr></thead><tbody>{hist.purchases.map((p: any) => (
            <tr key={p.intentId}><td className="mono wrap">{p.predictionVersion}</td><td>{p.entitled ? "Owned" : p.status === "partial" ? "Half paid, resume on the match page" : p.status}</td>
              <td>{p.legs.map((l: any) => l.explorer ? <a key={l.leg} className="block" href={l.explorer}>{l.leg} leg on Etherscan</a> : <span key={l.leg} className="block muted">{l.leg} leg unpaid</span>)}</td></tr>))}</tbody></table>}
    </>
  );
}

function Activation() {
  const { status } = useStatus();
  const rows: [string, boolean, string][] = [
    ["Free EPL analysis, backtest and accuracy report", true, "Bundled in this release from the pinned CC0 archive."],
    ["Companion service origin", !!COMPANION_ORIGIN, COMPANION_ORIGIN ? COMPANION_ORIGIN : "Empty in this release. The operator sets VITE_COMPANION_ORIGIN to an HTTPS origin they run, then rebuilds."],
    ["WalletConnect", !!WALLETCONNECT_PROJECT_ID, WALLETCONNECT_PROJECT_ID ? "Registered project ID set." : "Hidden until a registered WalletConnect project ID is set. MetaMask and Rabby connect by EIP-6963 without it."],
    ["Live scores, fixtures, availability", !!status && Object.values(status.feeds).some(Boolean), "Needs licensed feed keys (Sportradar, API-Sports) in the companion. Rights must cover a paid analysis product."],
    ["Swarm research", !!status?.research.activated, "Operator switch IMD_SPORT_RESEARCH_ACTIVE=1, an IMD API token and a funded research balance."],
    ["Checkout", !!status?.checkout.enabled, status ? (status.checkout.blockers.join("; ") || "Ready.") : "Needs the companion, both recipients, a verified token and a working receipt verifier."],
  ];
  return (
    <>
      <h1>What is on, and what needs activation</h1>
      <table className="tbl">
        <thead><tr><th scope="col">Feature</th><th scope="col">State</th><th scope="col">Detail</th></tr></thead>
        <tbody>{rows.map(([f, on, d]) => <tr key={f}><th scope="row">{f}</th><td>{on ? <span className="badge b-final">On</span> : <span className="badge b-unavailable">Off</span>}</td><td className="wrap">{d}</td></tr>)}</tbody>
      </table>
      <section className="card">
        <h2>Payment token</h2>
        <dl className="facts">
          <div><dt>Token</dt><dd>IMD on Ethereum Mainnet (chain ID 1), 18 decimals</dd></div>
          <div><dt>Address</dt><dd><a className="mono wrap" href={`https://etherscan.io/token/${TOKEN.address}`}>{TOKEN.address}</a></dd></div>
          <div><dt>Where it comes from</dt><dd>The Ethereum Mainnet entry of <a href="https://imd.fun/docs">imd.fun/docs</a></dd></div>
          <div><dt>Checked</dt><dd>Chain ID, deployed bytecode and decimals read from a mainnet RPC; source verified as an exact match on <a href={`https://repo.sourcify.dev/1/${TOKEN.address}`}>Sourcify</a>.</dd></div>
          <div><dt>Price</dt><dd>1 IMD per prediction version: 0.5 IMD to the developer and 0.5 IMD to Swarm research. Gas is separate.</dd></div>
          <div><dt>Recipients</dt><dd>{status?.checkout.recipients ? <span className="mono wrap">{status.checkout.recipients.developer}, {status.checkout.recipients.research}</span> : "Not set. They are operator settings with empty defaults, so no payment is requested."}</dd></div>
        </dl>
      </section>
      <section className="card">
        <h2>Research accounting</h2>
        <p className="muted small">Research allocations (the 0.5 IMD legs received) are tracked apart from spending the operator has authorized and what was spent on Swarm jobs.</p>
        <dl className="facts">
          <div><dt>Allocated</dt><dd className="num">{status ? Number(BigInt(status.research.allocatedUnits) / 10n ** 14n) / 1e4 : 0} IMD</dd></div>
          <div><dt>Authorized to spend</dt><dd className="num">{status ? Number(BigInt(status.research.authorizedUnits) / 10n ** 14n) / 1e4 : 0} IMD</dd></div>
          <div><dt>Spent</dt><dd className="num">{status ? Number(BigInt(status.research.spentUnits) / 10n ** 14n) / 1e4 : 0} IMD</dd></div>
        </dl>
      </section>
    </>
  );
}
