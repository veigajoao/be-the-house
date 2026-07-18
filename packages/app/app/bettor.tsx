"use client";
// Bettor surface: coupon (markets) -> slip drawer -> stub ladder.
// Status ladder: Committed (~15s) -> Odds locked (SSE, reads as DONE) ->
// Active (on-chain fill) -> Won/Lost (receipt with scores root + settle tx).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fmtDuration,
  fmtOdds,
  fmtUsdc,
  OUTCOME_LABEL,
  OUTCOME_SYM,
  type AppConfig,
  type BetView,
  type FixtureRow,
  type Quotes,
} from "../lib/types";
import type { useBthWallet } from "../lib/wallet";
import { chargeForStake, feeModel, feesOnStake, stakeForCharge, type FeeModel } from "../lib/fees";

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

function Stub({
  bet,
  result,
  network,
  fees,
}: {
  bet: BetView;
  result: { score: number[]; scoresRoot: string } | null;
  network: AppConfig["network"];
  fees: FeeModel | null;
}) {
  const now = Date.now();
  const quoted = ceilings.get(bet.pda);
  // What the bettor was actually charged (fee-inclusive) — bet.stake is the
  // net at-risk amount; add the fees back to show the headline they paid.
  const chargedUusdc = fees ? chargeForStake(bet.stake, fees) : bet.stake;
  const state = bet.state;
  // 15s commit delay has passed — waiting on the feed to print the target.
  const pastDelay = state === "pending" && now > bet.targetTsMs;

  let stamp: { cls: string; text: string };
  let foot: React.ReactNode;
  let oddsCell: string;
  let winCell = "—";

  if (state === "pending") {
    stamp = { cls: "stamp wait", text: pastDelay ? "Awaiting fill" : "Committed" };
    oddsCell = quoted ? `up to ${fmtOdds(quoted.ceiling)}` : "up to —";
    if (quoted) winCell = fmtUsdc((bet.stake * quoted.ceiling) / 1000);
    // the price locks against the FIRST feed print after commit+15s — on
    // devnet that's the next quote update, not a fixed 15s.
    foot =
      network === "devnet" ? (
        <>
          <span className="ok">✓ Committed on-chain.</span> Fills 15s after commit at the last
          oracle price — or a worse one if the feed prints a fresh update in that window (never a
          better one). The verified fill lands once the keeper cranks; a few minutes on devnet.
        </>
      ) : network === "surfnet" ? (
        <>
          <span className="ok">✓ Committed on-chain.</span> Fills 15s after commit at the last proven
          price (or a fresher print if one lands), once the keeper cranks.
        </>
      ) : (
        <>
          <span className="ok">✓ Committed on-chain.</span> Fills 15s after commit at the last oracle
          price — or a worse one if a fresh print lands in that window. The verified fill follows
          shortly. Nothing left to do.
        </>
      );
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
    foot = (
      <>
        Stake returned automatically (
        {state === "voided" ? "match abandoned" : "no oracle price at commit"}).
      </>
    );
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
          <b>{fmtUsdc(chargedUusdc)}</b>
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

function CouponSkeleton() {
  return (
    <>
      <div className="coupon" aria-busy="true">
        <div className="coupon-head">
          <div>Fixture</div>
          <div>1 Home</div>
          <div>X Draw</div>
          <div>2 Away</div>
        </div>
        {[0, 1, 2].map((i) => (
          <div className="fx" key={i}>
            <div className="fx-info" style={{ gap: 6 }}>
              <div className="skel skel-line" style={{ width: "45%" }} />
              <div className="skel skel-line" style={{ width: "62%", height: 9 }} />
            </div>
            {[0, 1, 2].map((j) => (
              <div key={j} className="pick" style={{ pointerEvents: "none" }}>
                <div className="skel skel-line" style={{ width: 34, height: 15 }} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="loading-note" style={{ marginTop: 10 }}>
        <span className="spinner" /> loading markets from the TxLINE feed…
      </p>
    </>
  );
}

function StubSkeleton() {
  return (
    <div className="stub" aria-busy="true">
      <div className="skel skel-line" style={{ width: "40%", height: 10 }} />
      <div className="skel skel-line" style={{ width: "65%", margin: "14px 0 8px" }} />
      <div className="stub-fig">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <div className="skel skel-line" style={{ width: 34, height: 9, marginBottom: 4 }} />
            <div className="skel skel-line" style={{ width: 46, height: 14 }} />
          </div>
        ))}
      </div>
      <div className="skel skel-line" style={{ width: 92, height: 22, marginTop: 13 }} />
    </div>
  );
}

export default function Bettor({
  config,
  wallet,
  onBalanceChange,
}: {
  config: AppConfig | null;
  wallet: ReturnType<typeof useBthWallet>;
  onBalanceChange?: () => void;
}) {
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [quotes, setQuotes] = useState<Record<number, Quotes>>({});
  const [bets, setBets] = useState<BetView[]>([]);
  const [results, setResults] = useState<Record<string, { score: number[]; scoresRoot: string }>>({});
  const [pick, setPick] = useState<Pick | null>(null);
  const [stake, setStake] = useState("50");
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState("");
  const [maxStake, setMaxStake] = useState<number | null>(null);
  // "ready" = at least one fetch has completed, so empty means empty (not loading)
  const [fixturesReady, setFixturesReady] = useState(false);
  const [betsReady, setBetsReady] = useState(false);
  const pollRef = useRef(0);
  const owner = wallet.address;

  // re-enter the loading state when the connected wallet changes
  useEffect(() => setBetsReady(false), [owner]);

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
    } finally {
      setFixturesReady(true);
    }
    if (!owner) {
      setBets([]);
      return;
    }
    try {
      const b = (await fetch(`/api/bets?owner=${owner}`).then((r) => r.json())) as BetView[];
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
    } finally {
      setBetsReady(true);
    }
  }, [results, owner]);

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
    if (!wallet.connected) {
      wallet.connect(); // opens the picker; user re-taps Place after connecting
      return;
    }
    setPlacing(true);
    setError("");
    setMaxStake(null);
    try {
      // 1. server builds the unsigned commit tx (routes to a house that can fill)
      const res = await fetch("/api/bet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixtureId: pick.fixture.FixtureId,
          outcome: pick.outcome,
          stakeUsdc: Number(stake.replace(/,/g, "")) || 0, // fee-inclusive spend
          bettor: wallet.address,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.maxStakeUsdc) setMaxStake(body.maxStakeUsdc);
        throw new Error(body.error ?? "commit failed");
      }
      // 2. the connected wallet signs & sends it (mobile → redirects to the app)
      await wallet.sign(body.tx);
      ceilings.set(body.bet, {
        ceiling: body.ceiling,
        spreadBps: body.spreadBps,
        oddsCap: body.oddsCap,
      });
      setPick(null);
      void poll();
      onBalanceChange?.(); // the commit debited stake + fees — refresh the chip
    } catch (e) {
      setError((e as Error).message.slice(0, 180));
    } finally {
      setPlacing(false);
    }
  }

  const pickBest = pick ? bestFor(pick.quotes, pick.outcome) : null;
  // The typed amount is the fee-INCLUSIVE total charged. Invert it to the stake
  // that actually rides (fees come out of it, not on top), so every figure below
  // — breakdown and "to win" — is computed on the real at-risk amount.
  const spendUsdc = Number(stake.replace(/,/g, "")) || 0;
  const fees = config ? feeModel(config) : null;
  const spendUusdc = Math.round(spendUsdc * 1e6);
  const netStakeUusdc = fees ? stakeForCharge(spendUusdc, fees) : 0;
  const breakdown = fees ? feesOnStake(netStakeUusdc, fees) : null;
  const tooSmall = spendUsdc > 0 && netStakeUusdc <= 0;
  const toWinUusdc =
    pickBest && netStakeUusdc > 0
      ? Math.floor((netStakeUusdc * pickBest.effOdds[pick!.outcome]) / 1000)
      : 0;

  return (
    <>
      <section className="sec">
        <p className="eyebrow">Open markets</p>
        {!fixturesReady ? (
          <CouponSkeleton />
        ) : fixtures.length === 0 ? (
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
                      {q && Date.now() - q.print.ts > 120_000 && (
                        <span style={{ color: "var(--gold)" }}>
                          {" "}
                          · price {Math.round((Date.now() - q.print.ts) / 60_000)}m old
                        </span>
                      )}
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
        {!wallet.connected ? (
          <div className="empty">
            Connect a wallet to place bets and see your slips.{" "}
            <button className="faucet" onClick={() => wallet.connect()} style={{ marginLeft: 8 }}>
              connect wallet
            </button>
          </div>
        ) : !betsReady ? (
          <div className="stubs">
            <StubSkeleton />
            <StubSkeleton />
          </div>
        ) : bets.length === 0 ? (
          <div className="empty">No bets yet. Tick an outcome above.</div>
        ) : (
          <div className="stubs">
            {bets.map((b) => (
              <Stub
                key={b.pda}
                bet={b}
                result={results[b.fixtureId] ?? null}
                network={config?.network ?? "mainnet"}
                fees={fees}
              />
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
                A ceiling, not a price. Your fill is the worse of now and{" "}
                {config ? fmtDuration(config.commitDelayMs) : "15s"} from now — so it can hold or
                dip slightly, never improve.
                {config && Date.now() - pick.quotes.print.ts > config.stalenessWindowMs && (
                  <>
                    {" "}
                    <b style={{ color: "var(--gold)" }}>
                      Heads up: last oracle price is{" "}
                      {Math.round((Date.now() - pick.quotes.print.ts) / 60_000)}m old — past this
                      deployment&apos;s {fmtDuration(config.stalenessWindowMs)} price window
                      (quoting lull). If no fresh print lands around your commit, the bet
                      auto-refunds in full after ~{fmtDuration(config.commitExpiryMs)}.
                    </b>
                  </>
                )}
              </div>
            </div>
            <div className="field">
              <span>USDC</span>
              <input
                inputMode="decimal"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                aria-label="Amount to spend"
              />
            </div>
            <div className="fieldnote">
              All-in — fees come out of this, nothing extra is charged.
            </div>
            <div className="rows">
              <div className="row">
                <em>Staked (rides on the bet)</em>
                <b>{breakdown ? fmtUsdc(netStakeUusdc) : "—"}</b>
              </div>
              <div className="row sub">
                <em>Frontend fee ({config?.frontendFeeBps ?? "—"} bps)</em>
                <b>{breakdown ? fmtUsdc(breakdown.frontend) : "—"}</b>
              </div>
              <div className="row sub">
                <em>Protocol fee ({config?.protocolFeeBps ?? "—"} bps)</em>
                <b>{breakdown ? fmtUsdc(breakdown.protocol) : "—"}</b>
              </div>
              <div className="row sub">
                <em>Keeper reward (fills your bet)</em>
                <b>{breakdown ? fmtUsdc(breakdown.keeper) : "—"}</b>
              </div>
              <div className="row">
                <em>Routed to</em>
                <b>{pickBest ? `House #${pickBest.houseId} (${pickBest.spreadBps} bps)` : "—"}</b>
              </div>
              <div className="row big">
                <em>To win</em>
                <b>{pickBest && toWinUusdc > 0 ? fmtUsdc(toWinUusdc) : "0.00"}</b>
              </div>
            </div>
            <button
              className="btn"
              disabled={placing || wallet.busy || !pickBest || tooSmall}
              onClick={place}
            >
              {placing || wallet.busy
                ? "Approve in your wallet…"
                : wallet.connected
                  ? "Place bet"
                  : "Connect wallet to bet"}
            </button>
            {tooSmall ? (
              <div className="guar" style={{ color: "var(--stamp)" }}>
                Too small — the {fees ? fmtUsdc(fees.keeperUusdc) : "—"} USDC keeper fee would eat it
                all. Bet a bit more.
              </div>
            ) : (
              <div className="guar">✓ Guaranteed fill — no slippage, no partial fills</div>
            )}
            {error && (
              <div className="annot" style={{ marginTop: 10 }}>
                {error}
                {maxStake != null && maxStake > 0 && (
                  <>
                    {" "}
                    <button
                      className="faucet"
                      style={{ marginTop: 6 }}
                      onClick={() => {
                        setStake(String(maxStake));
                        setError("");
                        setMaxStake(null);
                      }}
                    >
                      set stake to {maxStake}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
