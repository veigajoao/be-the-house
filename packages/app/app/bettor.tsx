"use client";
// Bettor surface: coupon (markets) -> slip drawer -> stub ladder.
// Status ladder: Committed (~15s) -> Odds locked (SSE, reads as DONE) ->
// Active (on-chain fill) -> Won/Lost (receipt with scores root + settle tx).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fmtOdds,
  fmtUsdc,
  OUTCOME_LABEL,
  OUTCOME_SYM,
  type AppConfig,
  type BetView,
  type FixtureRow,
  type Quotes,
} from "../lib/types";

const API = "/api"; // same-origin route handlers (Vercel-ready, no CORS)

interface Pick {
  fixture: FixtureRow;
  quotes: Quotes;
  outcome: number;
}

/** ceilings we quoted at placement, per bet pda — powers "Odds locked" */
const ceilings = new Map<string, { ceiling: number; spreadBps: number; oddsCap: number }>();

function countdown(ms: number): string {
  const d = ms - Date.now();
  if (d <= 0) return "kicked off";
  const h = Math.floor(d / 3600_000);
  const m = Math.floor((d % 3600_000) / 60_000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

function Stub({ bet, result }: { bet: BetView; result: { score: number[]; scoresRoot: string } | null }) {
  const now = Date.now();
  const quoted = ceilings.get(bet.pda);
  const state = bet.state;
  const committed = state === "pending" && now < bet.targetTsMs + 3_000;
  const locked = state === "pending" && !committed;

  let stamp: { cls: string; text: string };
  let foot: React.ReactNode;
  let oddsCell: string;
  let winCell = "—";

  if (committed) {
    stamp = { cls: "stamp wait", text: "Committed" };
    foot = <>Locking your price against the next feed print — about 15 seconds.</>;
    oddsCell = quoted ? `up to ${fmtOdds(quoted.ceiling)}` : "up to —";
    if (quoted) winCell = fmtUsdc((bet.stake * quoted.ceiling) / 1000);
  } else if (locked) {
    stamp = { cls: "stamp ok", text: "Odds locked" };
    oddsCell = quoted ? `≤ ${fmtOdds(quoted.ceiling)}` : "locked";
    foot = (
      <>
        <span className="ok">✓ Price fixed at the T+15s print.</span> On-chain proof lands in
        0.5–5.5 min. Nothing left to do.
      </>
    );
    if (quoted) winCell = fmtUsdc((bet.stake * quoted.ceiling) / 1000);
  } else if (state === "active") {
    stamp = { cls: "stamp ok", text: "Active" };
    oddsCell = fmtOdds(bet.fillOdds);
    winCell = fmtUsdc(bet.payout);
    foot = (
      <>
        <span className="ok">✓ Verified on-chain.</span> Settles at full time.
      </>
    );
  } else if (state === "won" || state === "lost") {
    stamp =
      state === "won"
        ? { cls: "stamp won", text: result ? `Won · ${result.score[0]}–${result.score[1]}` : "Won" }
        : { cls: "stamp lost", text: result ? `Lost · ${result.score[0]}–${result.score[1]}` : "Lost" };
    oddsCell = fmtOdds(bet.fillOdds);
    winCell = state === "won" ? fmtUsdc(bet.payout) : "0.00";
    foot = (
      <>
        Final score proved against TxLINE scores root
        <br />
        <span className="mono">
          {result ? `${result.scoresRoot.slice(0, 4)}…${result.scoresRoot.slice(-4)}` : "…"}
        </span>
        {bet.settleTx && (
          <>
            {" · "}
            <a href={`https://explorer.solana.com/tx/${bet.settleTx}`} target="_blank">
              settle tx ↗
            </a>
          </>
        )}
      </>
    );
  } else {
    stamp = { cls: "stamp refund", text: state === "voided" ? "Voided" : "Refunded" };
    oddsCell = "—";
    foot = <>Stake returned automatically ({state === "voided" ? "match abandoned" : "oracle silence"}).</>;
  }

  return (
    <div className="stub">
      <div className="stub-id">
        BET {bet.pda.slice(0, 4)}…{bet.pda.slice(-4)} ·{" "}
        {new Date(bet.commitTsMs).toUTCString().slice(17, 25)} UTC
      </div>
      <div className="stub-fx">{bet.fixture}</div>
      <div className="stub-out">
        {OUTCOME_SYM[bet.outcome]} · {OUTCOME_LABEL[bet.outcome]}
      </div>
      <div className="stub-fig">
        <div>
          <small>Stake</small>
          <b>{fmtUsdc(bet.stake)}</b>
        </div>
        <div>
          <small>Odds</small>
          <b>{oddsCell}</b>
        </div>
        <div>
          <small>{bet.state === "won" ? "Paid" : "To win"}</small>
          <b>{winCell}</b>
        </div>
      </div>
      <div className={stamp.cls}>{stamp.text}</div>
      <div className="stub-foot">{foot}</div>
    </div>
  );
}

export default function Bettor({ config }: { config: AppConfig | null }) {
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [quotes, setQuotes] = useState<Record<number, Quotes>>({});
  const [bets, setBets] = useState<BetView[]>([]);
  const [results, setResults] = useState<Record<string, { score: number[]; scoresRoot: string }>>({});
  const [pick, setPick] = useState<Pick | null>(null);
  const [stake, setStake] = useState("50");
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState("");
  const pollRef = useRef(0);

  const poll = useCallback(async () => {
    try {
      const fx = (await fetch(`${API}/fixtures`).then((r) => r.json())) as FixtureRow[];
      const upcoming = fx
        .filter((f) => f.StartTime > Date.now())
        .sort((a, b) => a.StartTime - b.StartTime)
        .slice(0, 10);
      setFixtures(upcoming);
      // quotes for each open fixture (404 = not quoting yet)
      const q: Record<number, Quotes> = {};
      await Promise.all(
        upcoming.map(async (f) => {
          const res = await fetch(`${API}/quotes/${f.FixtureId}`).catch(() => null);
          if (res?.ok) q[f.FixtureId] = await res.json();
        }),
      );
      setQuotes(q);
    } catch {
      /* API down */
    }
    try {
      const b = (await fetch("/api/bets").then((r) => r.json())) as BetView[];
      setBets(b);
      // fetch receipts for settled fixtures we haven't resolved yet
      for (const bet of b) {
        if ((bet.state === "won" || bet.state === "lost") && !results[bet.fixtureId]) {
          const r = await fetch(`/api/result/${bet.fixtureId}`).catch(() => null);
          if (r?.ok) {
            const body = await r.json();
            setResults((prev) => ({ ...prev, [bet.fixtureId]: body }));
          }
        }
      }
    } catch {
      /* chain down */
    }
  }, [results]);

  useEffect(() => {
    void poll();
    pollRef.current = window.setInterval(poll, 5_000);
    return () => clearInterval(pollRef.current);
  }, [poll]);

  const bestFor = (q: Quotes | undefined, o: number) => {
    if (!q?.quotes.length) return null;
    return q.quotes.reduce((a, b) => (b.effOdds[o] > a.effOdds[o] ? b : a));
  };

  async function place() {
    if (!pick) return;
    setPlacing(true);
    setError("");
    try {
      const res = await fetch("/api/bet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixtureId: pick.fixture.FixtureId,
          outcome: pick.outcome,
          stakeUsdc: Number(stake),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "commit failed");
      const best = bestFor(pick.quotes, pick.outcome)!;
      ceilings.set(body.bet, {
        ceiling: best.effOdds[pick.outcome],
        spreadBps: best.spreadBps,
        oddsCap: best.oddsCap,
      });
      setPick(null);
      void poll();
    } catch (e) {
      setError((e as Error).message.slice(0, 160));
    } finally {
      setPlacing(false);
    }
  }

  const stakeNum = Number(stake.replace(/,/g, "")) || 0;
  const pickBest = pick ? bestFor(pick.quotes, pick.outcome) : null;
  const feFee = config ? (stakeNum * config.frontendFeeBps) / 10_000 : 0;
  const pFee = config ? (stakeNum * config.protocolFeeBps) / 10_000 : 0;

  return (
    <>
      <section className="sec">
        <p className="eyebrow">Open markets</p>
        {fixtures.length === 0 ? (
          <div className="empty">
            No fixtures open right now. Markets open as kickoff times are published.
          </div>
        ) : (
          <div className="coupon">
            <div className="coupon-head">
              <div>Fixture</div>
              <div>1 Home</div>
              <div>X Draw</div>
              <div>2 Away</div>
            </div>
            {fixtures.map((f) => {
              const q = quotes[f.FixtureId];
              return (
                <div className="fx" key={f.FixtureId}>
                  <div className="fx-info">
                    <div className="fx-teams">
                      {f.Participant1} <span style={{ color: "var(--ink-3)" }}>—</span>{" "}
                      {f.Participant2}
                    </div>
                    <div className="fx-sub">
                      {f.Competition} · kickoff{" "}
                      {new Date(f.StartTime).toUTCString().slice(17, 22)} UTC ·{" "}
                      {countdown(f.StartTime)}
                    </div>
                  </div>
                  {[0, 1, 2].map((o) => {
                    const best = bestFor(q, o);
                    const selected =
                      pick?.fixture.FixtureId === f.FixtureId && pick.outcome === o;
                    return (
                      <button
                        key={o}
                        className="pick"
                        aria-pressed={selected}
                        disabled={!best}
                        onClick={() => q && setPick({ fixture: f, quotes: q, outcome: o })}
                      >
                        <small>{OUTCOME_SYM[o]}</small>
                        {best ? fmtOdds(best.effOdds[o]) : "—"}
                        <i className="box" />
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        <p className="annot">
          Each cell is the best odds across every house, straight from /quotes/:fixtureId.
          Routing picks the house; you never choose one.
        </p>
      </section>

      <section className="sec">
        <p className="eyebrow">My bets</p>
        {bets.length === 0 ? (
          <div className="empty">No bets yet. Tick an outcome above.</div>
        ) : (
          <div className="stubs">
            {bets.map((b) => (
              <Stub key={b.pda} bet={b} result={results[b.fixtureId] ?? null} />
            ))}
          </div>
        )}
        <p className="annot">
          Committed → Odds locked → Active → Won/Lost. "Odds locked" reads as DONE — the price
          is fixed there; on-chain finality is a checkmark, never a spinner. No cancel: a
          placed bet stays until settlement.
        </p>
      </section>

      {/* slip */}
      <aside className={`slip ${pick ? "on" : ""}`} aria-label="Bet slip">
        <div className="slip-head">
          <span>Bet slip</span>
          <button className="slip-x" aria-label="Close" onClick={() => setPick(null)}>
            ×
          </button>
        </div>
        {pick && (
          <div className="slip-body">
            <div className="slip-fx">
              {pick.fixture.Participant1} — {pick.fixture.Participant2}
            </div>
            <div className="slip-out">
              {OUTCOME_SYM[pick.outcome]} · {OUTCOME_LABEL[pick.outcome]}
            </div>
            <div className="ceil">
              <div className="ceil-top">
                <span className="ceil-lab">Up to</span>
                <b>{pickBest ? fmtOdds(pickBest.effOdds[pick.outcome]) : "—"}</b>
              </div>
              <div className="ceil-note">
                A ceiling, not a price. Your fill is the worse of now and 15s from now — so it
                can hold or dip slightly, never improve.
              </div>
            </div>
            <div className="field">
              <span>USDC</span>
              <input
                inputMode="decimal"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                aria-label="Stake"
              />
            </div>
            <div className="rows">
              <div className="row">
                <em>Frontend fee ({config?.frontendFeeBps ?? "—"} bps)</em>
                <b>{feFee.toFixed(2)}</b>
              </div>
              <div className="row">
                <em>Protocol fee ({config?.protocolFeeBps ?? "—"} bps)</em>
                <b>{pFee.toFixed(2)}</b>
              </div>
              <div className="row">
                <em>Routed to</em>
                <b>{pickBest ? `House #${pickBest.houseId} (${pickBest.spreadBps} bps)` : "—"}</b>
              </div>
              <div className="row big">
                <em>To win</em>
                <b>
                  {pickBest
                    ? ((stakeNum * pickBest.effOdds[pick.outcome]) / 1000).toFixed(2)
                    : "0.00"}
                </b>
              </div>
            </div>
            <button className="btn" disabled={placing || !pickBest} onClick={place}>
              {placing ? "Committing…" : "Place bet"}
            </button>
            <div className="guar">✓ Guaranteed fill — no slippage, no partial fills</div>
            {error && (
              <div className="annot" style={{ marginTop: 10 }}>
                {error}
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
