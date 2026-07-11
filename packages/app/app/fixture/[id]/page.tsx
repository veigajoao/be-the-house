"use client";
import { use, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL!;
const OUTCOMES = ["Home (1)", "Draw (X)", "Away (2)"];
const fmt = (x1000: number) => (x1000 / 1000).toFixed(3);

interface Quotes {
  fixtureId: number;
  print: { ts: number; prices: number[] };
  quotes: { house: string; spreadBps: number; effOdds: number[] }[];
  best: string[][];
}

interface BetView {
  pda: string;
  outcome: number;
  stake: number;
  state: string;
  fillOdds: number;
  payout: number;
}

export default function FixturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [quotes, setQuotes] = useState<Quotes | null>(null);
  const [bets, setBets] = useState<BetView[]>([]);
  const [stake, setStake] = useState("5");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let dead = false;
    const poll = async () => {
      try {
        const q = await fetch(`${API}/quotes/${id}`);
        if (q.ok && !dead) setQuotes(await q.json());
      } catch {}
      try {
        const b = await fetch(`/api/bets?fixtureId=${id}`);
        if (b.ok && !dead) setBets(await b.json());
      } catch {}
    };
    void poll();
    const t = setInterval(poll, 5_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [id]);

  async function placeBet(outcome: number) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/bet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixtureId: Number(id), outcome, stakeUsdc: Number(stake) }),
      });
      const body = await res.json();
      setMsg(res.ok ? `committed: ${body.bet}` : `failed: ${body.error}`);
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const bestHouse = quotes?.quotes.length
    ? [0, 1, 2].map((o) => quotes.quotes.reduce((a, b) => (b.effOdds[o] > a.effOdds[o] ? b : a)))
    : null;

  return (
    <main>
      <p>
        <a href="/" style={{ color: "#79c0ff" }}>
          ← fixtures
        </a>{" "}
        <span style={{ opacity: 0.6 }}>fixture {id}</span>
      </p>
      {!quotes && <p style={{ opacity: 0.6 }}>waiting for a live StablePrice print…</p>}
      {quotes && (
        <>
          <p style={{ opacity: 0.6 }}>
            StablePrice @ {new Date(quotes.print.ts).toUTCString()} — odds shown are a{" "}
            <b>ceiling</b> (&quot;up to&quot;): you fill at the worse of now / +15s.
          </p>
          <div style={{ display: "flex", gap: "1rem" }}>
            {OUTCOMES.map((label, o) => (
              <button
                key={o}
                disabled={busy || !bestHouse}
                onClick={() => placeBet(o)}
                style={{
                  flex: 1,
                  padding: "1rem",
                  background: "#161b22",
                  border: "1px solid #30363d",
                  color: "#e6e6e6",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                <div>{label}</div>
                <div style={{ fontSize: "1.4rem", color: "#7ee787" }}>
                  up to {bestHouse ? fmt(bestHouse[o].effOdds[o]) : "—"}
                </div>
                <div style={{ opacity: 0.5, fontSize: "0.75rem" }}>
                  best house {bestHouse ? bestHouse[o].house.slice(0, 8) : "—"}… (
                  {bestHouse ? bestHouse[o].spreadBps : "—"} bps)
                </div>
              </button>
            ))}
          </div>
          <p>
            stake{" "}
            <input
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              style={{
                background: "#161b22",
                color: "#e6e6e6",
                border: "1px solid #30363d",
                padding: "0.3rem",
                width: "5rem",
              }}
            />{" "}
            USDC
          </p>
        </>
      )}
      {msg && <p style={{ color: msg.startsWith("failed") ? "#ff7b72" : "#7ee787" }}>{msg}</p>}

      <h3 style={{ fontSize: "0.9rem", opacity: 0.7 }}>Your bets</h3>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {bets.map((b) => (
          <li key={b.pda} style={{ margin: "0.4rem 0" }}>
            <code>{b.pda.slice(0, 8)}…</code> {OUTCOMES[b.outcome]} · {b.stake / 1e6} USDC ·{" "}
            <b
              style={{
                color:
                  b.state === "won"
                    ? "#7ee787"
                    : b.state === "lost"
                      ? "#ff7b72"
                      : b.state === "active"
                        ? "#79c0ff"
                        : "#e3b341",
              }}
            >
              {b.state === "pending"
                ? "pending — odds lock at commit+15s"
                : b.state === "active"
                  ? `active @ ${fmt(b.fillOdds)} → pays ${b.payout / 1e6}`
                  : b.state}
            </b>
          </li>
        ))}
      </ul>
    </main>
  );
}
