"use client";
// House surface: vault three-way split, per-fixture exposure bars, settings.
// Exposes the machinery — the LP wants to see exactly what they're exposed to.
import { useCallback, useEffect, useState } from "react";
import { fmtUsdc, type HouseView } from "../lib/types";

function VaultPanel({ h, onAction }: { h: HouseView; onAction: () => void }) {
  const [amount, setAmount] = useState("100");
  const [busy, setBusy] = useState(false);
  const total = Math.max(h.vault, 1);
  const pct = (n: number) => `${Math.max(0, (n / total) * 100)}%`;

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    await fetch("/api/house", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, house: h.pda, amountUsdc: Number(amount), ...extra }),
    });
    setBusy(false);
    onAction();
  }

  return (
    <div className="panel">
      <div className="vault">
        <div className="vault-lab">
          House #{h.houseId} vault {h.paused && "· PAUSED"}
        </div>
        <div className="vault-total">
          {fmtUsdc(h.vault)} <span style={{ fontSize: 14, color: "var(--ink-2)" }}>USDC</span>
        </div>
      </div>
      <div
        className="bar"
        role="img"
        aria-label={`Free ${fmtUsdc(h.free)}, reserved ${fmtUsdc(h.reserved)}, locked ${fmtUsdc(h.locked)}`}
      >
        <i className="free" style={{ flex: `0 0 ${pct(h.free)}` }} />
        <i className="res" style={{ flex: `0 0 ${pct(h.reserved)}` }} />
        <i className="lock" style={{ flex: 1 }} />
      </div>
      <div className="key">
        <div className="key-row">
          <i className="sw free" />
          <em>Free — withdrawable now</em>
          <b>{fmtUsdc(h.free)}</b>
        </div>
        <div className="key-row">
          <i className="sw res" />
          <em>Reserved — pending commits, held at odds cap</em>
          <b>{fmtUsdc(h.reserved)}</b>
        </div>
        <div className="key-row">
          <i className="sw lock" />
          <em>Locked — filled bets, netted</em>
          <b>{fmtUsdc(h.locked)}</b>
        </div>
      </div>
      <div className="inv">
        vault ≥ locked, always. Every payout is pre-funded — this house cannot go insolvent.
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <div className="field" style={{ marginBottom: 0, flex: 1 }}>
          <span>USDC</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
        </div>
        <button className="faucet" disabled={busy} onClick={() => act("deposit")}>
          Deposit
        </button>
        <button className="faucet" disabled={busy} onClick={() => act("withdraw")}>
          Withdraw
        </button>
        <button
          className="faucet"
          disabled={busy}
          onClick={() => act("setPaused", { paused: !h.paused })}
        >
          {h.paused ? "Unpause" : "Pause"}
        </button>
      </div>
    </div>
  );
}

function ExposurePanel({ h }: { h: HouseView }) {
  const open = h.exposures.filter((e) => e.openBets > 0 || e.locked > 0);
  if (!open.length)
    return <div className="empty">No open exposure. Commits will create it lazily.</div>;
  return (
    <>
      {open.map((e) => {
        const max = Math.max(...e.liability, 1);
        const maxIdx = e.liability.indexOf(Math.max(...e.liability));
        return (
          <div className="panel exp-block" key={e.fixtureId}>
            <div className="exp">
              <div className="exp-fx">Fixture #{e.fixtureId}</div>
              {(["1 HOME", "X DRAW", "2 AWAY"] as const).map((lab, o) => (
                <div className={`exp-row ${o === maxIdx ? "max" : ""}`} key={o}>
                  <span>{lab}</span>
                  <div className="exp-bar">
                    <i style={{ width: `${(e.liability[o] / max) * 100}%` }} />
                  </div>
                  <b>{fmtUsdc(e.liability[o])}</b>
                </div>
              ))}
              <div className="exp-net">
                worst case <b>{fmtUsdc(Math.max(...e.liability))}</b> − stakes collected{" "}
                <b>{fmtUsdc(e.stakesCollected)}</b> = locked <b>{fmtUsdc(e.locked)}</b>
                <br />
                Balance the book and this goes to zero. Skew widens the heavy side to get you
                there.
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

function SettingsPanel({ h, onAction }: { h: HouseView | null; onAction: () => void }) {
  const [spread, setSpread] = useState(h?.spreadBps ?? 200);
  const [cap, setCap] = useState((h?.oddsCap ?? 15_000) / 1000);
  const [skew, setSkew] = useState(h?.skewCoeffBps ?? 2_000);
  const [perFixture, setPerFixture] = useState(String((h?.maxRiskPerFixture ?? 2_000_000_000) / 1e6));
  const [total, setTotal] = useState(String((h?.maxTotalRisk ?? 4_000_000_000) / 1e6));
  const [deposit, setDeposit] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function save() {
    setBusy(true);
    setMsg("");
    const params = {
      spreadBps: spread,
      skewCoeffBps: skew,
      oddsCap: Math.round(cap * 1000),
      maxRiskPerFixtureUsdc: Number(perFixture),
      maxTotalRiskUsdc: Number(total),
    };
    const body = h
      ? { action: "updateParams", house: h.pda, params }
      : { action: "create", houseId: Math.floor(Math.random() * 60_000), params, amountUsdc: Number(deposit) };
    const res = await fetch("/api/house", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    setMsg(res.ok ? (h ? "saved" : `created ${out.house?.slice(0, 8)}…`) : out.error);
    setBusy(false);
    onAction();
  }

  return (
    <div className="panel form">
      {!h && (
        <label>
          <span className="lab">
            Deposit <b>{deposit}</b>
          </span>
          <input type="text" value={deposit} onChange={(e) => setDeposit(e.target.value)} aria-label="Deposit USDC" />
        </label>
      )}
      <label>
        <span className="lab">
          Spread <b>{spread} bps</b>
        </span>
        <input
          type="range"
          min={50}
          max={600}
          step={10}
          value={spread}
          onChange={(e) => setSpread(Number(e.target.value))}
        />
        <div className="readout">
          Your edge on every fill. Tighter spread wins more flow at thinner margin — you're
          bidding against every other house.
        </div>
      </label>
      <label>
        <span className="lab">
          Odds cap <b>{cap.toFixed(1)}×</b>
        </span>
        <input
          type="range"
          min={2}
          max={25}
          step={0.5}
          value={cap}
          onChange={(e) => setCap(Number(e.target.value))}
        />
        <div className="readout">
          Reserves <b>${cap.toFixed(2)}</b> per $1 staked until the bet fills. Raise it to
          quote long shots; lower it for capital efficiency.
        </div>
      </label>
      <label>
        <span className="lab">
          Skew coefficient <b>{skew} bps</b>
        </span>
        <input
          type="range"
          min={0}
          max={10_000}
          step={100}
          value={skew}
          onChange={(e) => setSkew(Number(e.target.value))}
        />
        <div className="readout">
          Widens the heavy side of your book as it fills, steering flow toward balance.
        </div>
      </label>
      <label>
        <span className="lab">
          Max risk per fixture <b>{perFixture}</b>
        </span>
        <input type="text" value={perFixture} onChange={(e) => setPerFixture(e.target.value)} aria-label="Max risk per fixture" />
      </label>
      <label>
        <span className="lab">
          Max total risk <b>{total}</b>
        </span>
        <input type="text" value={total} onChange={(e) => setTotal(e.target.value)} aria-label="Max total risk" />
      </label>
      <button className="btn" disabled={busy} onClick={save}>
        {h ? "Save settings" : "Create house"}
      </button>
      {msg && (
        <div className="annot" style={{ marginTop: 10 }}>
          {msg}
        </div>
      )}
    </div>
  );
}

export default function House() {
  const [houses, setHouses] = useState<HouseView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const h = (await fetch("/api/houses").then((r) => r.json())) as HouseView[];
      setHouses(h);
      if (!selected && h.length) setSelected(h[0].pda);
    } catch {
      /* chain down */
    }
  }, [selected]);

  useEffect(() => {
    void poll();
    const t = setInterval(poll, 5_000);
    return () => clearInterval(t);
  }, [poll]);

  const h = houses.find((x) => x.pda === selected) ?? null;

  return (
    <div className="grid2">
      <div>
        <section className="sec">
          <p className="eyebrow">
            Vault
            {houses.length > 1 && (
              <select
                value={selected ?? ""}
                onChange={(e) => setSelected(e.target.value)}
                style={{ fontFamily: "var(--mono)", fontSize: 11, marginLeft: 8 }}
              >
                {houses.map((x) => (
                  <option key={x.pda} value={x.pda}>
                    House #{x.houseId} ({x.pda.slice(0, 6)}…)
                  </option>
                ))}
              </select>
            )}
          </p>
          {h ? (
            <VaultPanel h={h} onAction={poll} />
          ) : (
            <div className="empty">No houses yet — create one on the right.</div>
          )}
          <p className="annot">
            Reserved is separate from locked on purpose. A commit reserves worst-case (stake ×
            odds cap); the excess is released back at fill. Merge the two and the LP thinks
            they're being drained.
          </p>
        </section>

        <section className="sec">
          <p className="eyebrow">Exposure</p>
          {h && <ExposurePanel h={h} />}
          <p className="annot">
            Three bars, max highlighted. The tallest bar IS the exposure — everything else is
            noise.
          </p>
        </section>
      </div>

      <section className="sec">
        <p className="eyebrow">{h ? "House settings" : "Create house"}</p>
        <SettingsPanel key={h?.pda ?? "new"} h={h} onAction={poll} />
        <p className="annot">
          Odds cap is a capital knob, not a nerd knob — so it reads out in dollars reserved per
          dollar staked.
        </p>
      </section>
    </div>
  );
}
