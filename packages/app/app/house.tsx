"use client";
// House surface, split two ways:
//   My House — the house owned by YOUR connected wallet (one per wallet):
//     create / fund / configure params / set offer policy (competition &
//     match allow-or-deny) / pause / withdraw. All wallet-signed.
//   All Houses — read-only aggregate: every house's spread, vault, exposure
//     and published offer policy.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fmtOdds, fmtUsdc, type FixtureRow, type HouseView } from "../lib/types";
import type { useBthWallet } from "../lib/wallet";

type Wallet = ReturnType<typeof useBthWallet>;
type FilterMode = "all" | "only" | "except";

// ---- shared tx-flow primitives (pending spinner + scoped result note) ----
type Msg = { kind: "ok" | "err"; text: string; scope: string };
// which panel a given action's result note belongs under
const ACTION_SCOPE: Record<string, string> = {
  create: "create",
  deposit: "vault",
  withdraw: "vault",
  setPaused: "vault",
  setFilters: "filters",
  updateParams: "settings",
};
type Act = (action: string, extra: Record<string, unknown>, guardError?: string | null) => void;

/** A button that shows an inline spinner while ITS action is in flight, and is
 * disabled whenever ANY action is in flight (prevents double-submits). */
function ActBtn({
  className,
  pending,
  action,
  idle,
  busyLabel = "confirm in wallet…",
  disabled = false,
  onClick,
}: {
  className: string;
  pending: string | null;
  action: string;
  idle: ReactNode;
  busyLabel?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={className} disabled={disabled || pending !== null} onClick={onClick}>
      {pending === action ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="spinner" /> {busyLabel}
        </span>
      ) : (
        idle
      )}
    </button>
  );
}

/** Result/error note, shown only under the panel that owns the action. */
function Note({ msg, scope }: { msg: Msg | null; scope: string }) {
  if (!msg || msg.scope !== scope) return null;
  return (
    <div
      className="annot"
      style={{ marginTop: 10, color: msg.kind === "err" ? "var(--stamp)" : "var(--green)" }}
    >
      {msg.text}
    </div>
  );
}

const DEFAULT_PARAMS = {
  spreadBps: 150,
  skewCoeffBps: 2000,
  oddsCap: 15000,
  maxRiskPerFixtureUsdc: 5000,
  maxTotalRiskUsdc: 10000,
};

/** (allow, list) ← UI mode + selection */
function modeToRule(mode: FilterMode, selected: (string | number)[]) {
  if (mode === "all") return { allow: false, list: [] as (string | number)[] };
  if (mode === "only") return { allow: true, list: selected };
  return { allow: false, list: selected };
}
/** UI mode ← on-chain (allow, listLength) */
function ruleToMode(allow: boolean, listLen: number): FilterMode {
  if (listLen === 0) return "all";
  return allow ? "only" : "except";
}

interface PolicyState {
  compMode: FilterMode;
  comps: number[];
  fxMode: FilterMode;
  fxs: string[];
}
const OPEN_POLICY: PolicyState = { compMode: "all", comps: [], fxMode: "all", fxs: [] };
const policyFromFilters = (f: HouseView["filters"]): PolicyState =>
  f
    ? {
        compMode: ruleToMode(f.competitionAllow, f.competitions.length),
        comps: f.competitions,
        fxMode: ruleToMode(f.fixtureAllow, f.fixtures.length),
        fxs: f.fixtures,
      }
    : OPEN_POLICY;
const isOpenPolicy = (p: PolicyState) => p.compMode === "all" && p.fxMode === "all";
function policyToFilters(p: PolicyState) {
  const c = modeToRule(p.compMode, p.comps);
  const x = modeToRule(p.fxMode, p.fxs);
  return {
    competitionAllow: c.allow,
    competitions: c.list as number[],
    fixtureAllow: x.allow,
    fixtures: x.list as string[],
  };
}

export default function House({
  wallet,
  usdcBalance,
  onBalanceChange,
}: {
  wallet: Wallet;
  usdcBalance: number; // base units (µUSDC) of the connected wallet
  onBalanceChange?: () => void;
}) {
  const [view, setView] = useState<"mine" | "all">("mine");
  const [houses, setHouses] = useState<HouseView[]>([]);
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [pending, setPending] = useState<string | null>(null); // action in flight
  const [msg, setMsg] = useState<Msg | null>(null);
  const owner = wallet.address;

  const poll = useCallback(async () => {
    try {
      const [h, fx] = await Promise.all([
        fetch("/api/houses").then((r) => r.json()) as Promise<HouseView[]>,
        fetch("/api/fixtures").then((r) => r.json()) as Promise<FixtureRow[]>,
      ]);
      setHouses(h);
      setFixtures(fx);
    } catch {
      /* chain down */
    }
  }, []);

  useEffect(() => {
    void poll();
    const t = setInterval(poll, 8_000);
    return () => clearInterval(t);
  }, [poll]);

  const myHouse = owner ? houses.find((h) => h.owner === owner) ?? null : null;

  const SUCCESS: Record<string, string> = {
    create: "✓ House created and funded.",
    deposit: "✓ Deposit confirmed.",
    withdraw: "✓ Withdrawal confirmed.",
    setPaused: "✓ Saved.",
    setFilters: "✓ Offer policy saved.",
    updateParams: "✓ Parameters saved.",
  };
  const humanize = (e: unknown): string => {
    const raw = (e as Error)?.message ?? "";
    if (/reject|denied|declined|cancel|user.*abort/i.test(raw)) return "Cancelled in your wallet.";
    if (/insufficient|debit an account|0x1\b|not enough/i.test(raw))
      return "Transaction failed — not enough funds for this amount.";
    return raw.slice(0, 160) || "Transaction failed. Please try again.";
  };

  /** Validate (client-side) → build (server) → wallet-sign → refresh. A truthy
   * guardError short-circuits with an inline message before anything is sent. */
  async function act(action: string, extra: Record<string, unknown>, guardError?: string | null) {
    if (!owner) {
      wallet.connect();
      return;
    }
    const scope = ACTION_SCOPE[action] ?? action;
    if (guardError) {
      setMsg({ kind: "err", text: guardError, scope });
      return;
    }
    setPending(action);
    setMsg(null);
    try {
      const res = await fetch("/api/house", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, owner, ...extra }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed");
      await wallet.sign(body.tx);
      setMsg({ kind: "ok", text: SUCCESS[action] ?? "✓ Saved.", scope });
      setTimeout(poll, 1200);
      onBalanceChange?.(); // create/deposit/withdraw move USDC — refresh the chip
    } catch (e) {
      setMsg({ kind: "err", text: humanize(e), scope });
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <div className="tabs" role="tablist" style={{ marginBottom: 24 }}>
        <button className="tab" aria-selected={view === "mine"} onClick={() => setView("mine")}>
          My House
        </button>
        <button className="tab" aria-selected={view === "all"} onClick={() => setView("all")}>
          All Houses ({houses.length})
        </button>
      </div>

      {view === "mine" ? (
        !owner ? (
          <div className="empty">
            Connect a wallet to run a house.{" "}
            <button className="faucet" style={{ marginLeft: 8 }} onClick={() => wallet.connect()}>
              connect wallet
            </button>
          </div>
        ) : myHouse ? (
          <MyHouse
            house={myHouse}
            fixtures={fixtures}
            pending={pending}
            msg={msg}
            usdcBalance={usdcBalance}
            act={act}
          />
        ) : (
          <CreateHouse
            fixtures={fixtures}
            pending={pending}
            msg={msg}
            usdcBalance={usdcBalance}
            act={act}
          />
        )
      ) : (
        <AllHouses houses={houses} fixtures={fixtures} myOwner={owner} />
      )}
    </>
  );
}

// ---------- reusable offer-policy editor ----------
function OfferPolicyFields({
  fixtures,
  policy,
  setPolicy,
}: {
  fixtures: FixtureRow[];
  policy: PolicyState;
  setPolicy: (p: PolicyState) => void;
}) {
  const competitions = useMemo(() => {
    const m = new Map<number, string>();
    fixtures.forEach((f) => m.set(f.CompetitionId, f.Competition));
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [fixtures]);
  const toggle = <T,>(arr: T[], v: T) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  return (
    <>
      <label>
        <span className="lab">Competitions</span>
        <ModeSelect mode={policy.compMode} onChange={(compMode) => setPolicy({ ...policy, compMode })} />
      </label>
      {policy.compMode !== "all" && (
        <div className="filter-chips">
          {competitions.map((c) => (
            <button
              key={c.id}
              className={`chip ${policy.comps.includes(c.id) ? "on" : ""}`}
              onClick={() => setPolicy({ ...policy, comps: toggle(policy.comps, c.id) })}
            >
              {c.name}
            </button>
          ))}
          {competitions.length === 0 && <span className="annot">no competitions in the feed yet</span>}
        </div>
      )}

      <label style={{ marginTop: 16 }}>
        <span className="lab">Individual matches</span>
        <ModeSelect mode={policy.fxMode} onChange={(fxMode) => setPolicy({ ...policy, fxMode })} />
      </label>
      {policy.fxMode !== "all" && (
        <div className="filter-chips">
          {fixtures.map((f) => (
            <button
              key={f.FixtureId}
              className={`chip ${policy.fxs.includes(String(f.FixtureId)) ? "on" : ""}`}
              onClick={() => setPolicy({ ...policy, fxs: toggle(policy.fxs, String(f.FixtureId)) })}
            >
              {f.Participant1} — {f.Participant2}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---------- create ----------
function CreateHouse({
  fixtures,
  pending,
  msg,
  usdcBalance,
  act,
}: {
  fixtures: FixtureRow[];
  pending: string | null;
  msg: Msg | null;
  usdcBalance: number;
  act: Act;
}) {
  const [deposit, setDeposit] = useState("10000");
  const [p, setP] = useState(DEFAULT_PARAMS);
  const [policy, setPolicy] = useState<PolicyState>(OPEN_POLICY);
  const depNum = Number(deposit.replace(/,/g, "")) || 0;
  const depGuard =
    depNum <= 0
      ? "Enter a deposit amount."
      : depNum * 1e6 > usdcBalance
        ? `You only have ${fmtUsdc(usdcBalance)} USDC — deposit that or less.`
        : null;
  return (
    <section className="sec">
      <p className="eyebrow">Create your house</p>

      <div className="house-intro">
        <h3>What it means to be the house</h3>
        <p>
          You&apos;re opening a book. Bettors bet <b>against your vault</b>: you keep the losing
          stakes and pay out the winners. Your profit is the <b>spread</b> — a small margin baked
          into every price you quote — which makes you money in the long run across many bets, the
          same way a bookmaker&apos;s edge does.
        </p>
        <p>
          The oracle sets the fair price; you only choose <b>how much edge to take</b>, <b>how
          hard to auto-balance</b> your book, and <b>how much you&apos;ll risk</b> per game. You
          can&apos;t go bust — the protocol pre-funds every payout from your vault, and you withdraw
          the free (unlocked) part whenever you like. The knobs below are your risk controls.
        </p>
      </div>

      <div className="grid2">
        <div className="panel form">
          <ParamSliders p={p} setP={setP} />
        </div>
        <div>
          <div className="panel form">
            <label>
              <span className="lab">
                Initial deposit <b>{deposit} USDC</b>
              </span>
              <input type="text" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            </label>
            <div className="readout">
              You&apos;re the sole owner — only you can withdraw. The protocol pre-funds every payout
              from this vault (vault ≥ locked, always), so your house can never go insolvent.
            </div>
          </div>
          <div className="panel form" style={{ marginTop: 20 }}>
            <p className="lab" style={{ marginBottom: 10 }}>Offer policy (optional)</p>
            <div className="readout" style={{ marginBottom: 12 }}>
              Which markets your house quotes. Leave both on <b>Offer all</b> to take everything.
              The match rule is enforced on-chain; competitions are applied by routing.
            </div>
            <OfferPolicyFields fixtures={fixtures} policy={policy} setPolicy={setPolicy} />
          </div>
          <div style={{ marginTop: 14 }}>
            <ActBtn
              className="btn"
              pending={pending}
              action="create"
              busyLabel="creating house…"
              idle="Create house + deposit"
              onClick={() =>
                act(
                  "create",
                  {
                    params: p,
                    amountUsdc: depNum,
                    filters: isOpenPolicy(policy) ? undefined : policyToFilters(policy),
                  },
                  depGuard,
                )
              }
            />
          </div>
          <Note msg={msg} scope="create" />
        </div>
      </div>
    </section>
  );
}

// ---------- my house ----------
function MyHouse({
  house,
  fixtures,
  pending,
  msg,
  usdcBalance,
  act,
}: {
  house: HouseView;
  fixtures: FixtureRow[];
  pending: string | null;
  msg: Msg | null;
  usdcBalance: number;
  act: Act;
}) {
  return (
    <div className="grid2">
      <div>
        <VaultPanel house={house} pending={pending} msg={msg} usdcBalance={usdcBalance} act={act} />
        <FiltersPanel house={house} fixtures={fixtures} pending={pending} msg={msg} act={act} />
        <ExposurePanel house={house} fixtures={fixtures} />
      </div>
      <SettingsPanel house={house} pending={pending} msg={msg} act={act} />
    </div>
  );
}

function VaultPanel({
  house,
  pending,
  msg,
  usdcBalance,
  act,
}: {
  house: HouseView;
  pending: string | null;
  msg: Msg | null;
  usdcBalance: number;
  act: Act;
}) {
  const [amount, setAmount] = useState("1000");
  const amtNum = Number(amount.replace(/,/g, "")) || 0;
  const depGuard =
    amtNum <= 0
      ? "Enter an amount."
      : amtNum * 1e6 > usdcBalance
        ? `You only have ${fmtUsdc(usdcBalance)} USDC.`
        : null;
  const wdGuard =
    amtNum <= 0
      ? "Enter an amount."
      : amtNum * 1e6 > house.free
        ? `Only ${fmtUsdc(house.free)} USDC is free to withdraw.`
        : null;
  const total = Math.max(house.vault, 1);
  const pct = (n: number) => `${Math.max(0, (n / total) * 100)}%`;
  return (
    <section className="sec">
      <p className="eyebrow">Vault{house.paused && " · PAUSED"}</p>
      <div className="panel">
        <div className="vault">
          <div className="vault-lab">Total deposited</div>
          <div className="vault-total">
            {fmtUsdc(house.vault)} <span style={{ fontSize: 14, color: "var(--ink-2)" }}>USDC</span>
          </div>
        </div>
        <div className="bar" role="img">
          <i className="free" style={{ flex: `0 0 ${pct(house.free)}` }} />
          <i className="res" style={{ flex: `0 0 ${pct(house.reserved)}` }} />
          <i className="lock" style={{ flex: 1 }} />
        </div>
        <div className="key">
          <div className="key-row">
            <i className="sw free" /> <em>Free — withdrawable now</em> <b>{fmtUsdc(house.free)}</b>
          </div>
          <div className="key-row">
            <i className="sw res" /> <em>Reserved — pending commits, at odds cap</em>{" "}
            <b>{fmtUsdc(house.reserved)}</b>
          </div>
          <div className="key-row">
            <i className="sw lock" /> <em>Locked — filled bets, netted</em>{" "}
            <b>{fmtUsdc(house.locked)}</b>
          </div>
        </div>
        <div className="inv">
          vault ≥ locked, always. Every payout is pre-funded — this house cannot go insolvent.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
          <div className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span>USDC</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <ActBtn
            className="faucet"
            pending={pending}
            action="deposit"
            busyLabel="depositing…"
            idle="Deposit"
            onClick={() => act("deposit", { amountUsdc: amtNum }, depGuard)}
          />
          <ActBtn
            className="faucet"
            pending={pending}
            action="withdraw"
            busyLabel="withdrawing…"
            idle="Withdraw"
            onClick={() => act("withdraw", { amountUsdc: amtNum }, wdGuard)}
          />
          <ActBtn
            className="faucet"
            pending={pending}
            action="setPaused"
            busyLabel="…"
            idle={house.paused ? "Unpause" : "Pause"}
            onClick={() => act("setPaused", { paused: !house.paused })}
          />
        </div>
        <Note msg={msg} scope="vault" />
      </div>
    </section>
  );
}

function FiltersPanel({
  house,
  fixtures,
  pending,
  msg,
  act,
}: {
  house: HouseView;
  fixtures: FixtureRow[];
  pending: string | null;
  msg: Msg | null;
  act: Act;
}) {
  const [policy, setPolicy] = useState<PolicyState>(policyFromFilters(house.filters));
  return (
    <section className="sec">
      <p className="eyebrow">Offer policy</p>
      <div className="panel form">
        <div className="readout" style={{ marginBottom: 12 }}>
          Choose which markets your house quotes. The <b>match</b> rule is enforced on-chain at
          commit; the <b>competition</b> rule is applied by routing. Default (offer all) leaves both
          open.
        </div>
        <OfferPolicyFields fixtures={fixtures} policy={policy} setPolicy={setPolicy} />
        <div style={{ marginTop: 16 }}>
          <ActBtn
            className="btn"
            pending={pending}
            action="setFilters"
            busyLabel="saving…"
            idle="Save offer policy"
            onClick={() => act("setFilters", { filters: policyToFilters(policy) })}
          />
        </div>
        <Note msg={msg} scope="filters" />
      </div>
    </section>
  );
}

function ModeSelect({ mode, onChange }: { mode: FilterMode; onChange: (m: FilterMode) => void }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {(["all", "only", "except"] as const).map((m) => (
        <button
          key={m}
          className={`chip ${mode === m ? "on" : ""}`}
          onClick={() => onChange(m)}
        >
          {m === "all" ? "Offer all" : m === "only" ? "Only selected" : "All except"}
        </button>
      ))}
    </div>
  );
}

function SettingsPanel({
  house,
  pending,
  msg,
  act,
}: {
  house: HouseView;
  pending: string | null;
  msg: Msg | null;
  act: Act;
}) {
  const [p, setP] = useState({
    spreadBps: house.spreadBps,
    skewCoeffBps: house.skewCoeffBps,
    oddsCap: house.oddsCap,
    maxRiskPerFixtureUsdc: house.maxRiskPerFixture / 1e6,
    maxTotalRiskUsdc: house.maxTotalRisk / 1e6,
  });
  return (
    <section className="sec">
      <p className="eyebrow">Parameters</p>
      <div className="panel form">
        <ParamSliders p={p} setP={setP} />
        <ActBtn
          className="btn"
          pending={pending}
          action="updateParams"
          busyLabel="saving…"
          idle="Save parameters"
          onClick={() => act("updateParams", { params: p })}
        />
        <Note msg={msg} scope="settings" />
        <p className="annot" style={{ marginTop: 12 }}>
          Params apply to future fills only. Tighter spread wins more routed flow; odds cap reserves
          ${(p.oddsCap / 1000).toFixed(2)} per $1 staked until a bet fills.
        </p>
      </div>
    </section>
  );
}

function ParamSliders({
  p,
  setP,
}: {
  p: typeof DEFAULT_PARAMS;
  setP: (p: typeof DEFAULT_PARAMS) => void;
}) {
  const set = (k: keyof typeof DEFAULT_PARAMS, v: number) => setP({ ...p, [k]: v });
  const pct = (bps: number) => (bps / 100).toFixed(bps % 100 ? 2 : 0);
  return (
    <>
      <label>
        <span className="lab">
          Spread <b>{p.spreadBps} bps</b>
        </span>
        <input type="range" min={20} max={600} step={10} value={p.spreadBps}
          onChange={(e) => set("spreadBps", Number(e.target.value))} />
        <div className="phelp">
          Your <b>profit margin</b> on every fill — {p.spreadBps} bps = you quote {pct(p.spreadBps)}%
          below the fair price and keep the difference. <b>Lower</b> → you win more bets (you&apos;re
          competing with other houses on price) at a thinner margin; <b>higher</b> → more profit per
          bet, less flow. <span className="hint">typical 50–300 bps</span>
        </div>
      </label>
      <label>
        <span className="lab">
          Skew coefficient <b>{p.skewCoeffBps} bps</b>
        </span>
        <input type="range" min={0} max={10000} step={100} value={p.skewCoeffBps}
          onChange={(e) => set("skewCoeffBps", Number(e.target.value))} />
        <div className="phelp">
          <b>Auto-balances your book.</b> When bets pile onto one outcome, your price on that side
          worsens to push new flow to the other side. <b>Higher</b> → rebalances harder (safer, but
          your odds go uncompetitive sooner). <b>0</b> → you&apos;re happy holding one-sided risk.{" "}
          <span className="hint">start ~2000</span>
        </div>
      </label>
      <label>
        <span className="lab">
          Odds cap <b>{(p.oddsCap / 1000).toFixed(1)}×</b>
        </span>
        <input type="range" min={2000} max={25000} step={500} value={p.oddsCap}
          onChange={(e) => set("oddsCap", Number(e.target.value))} />
        <div className="phelp">
          The most you&apos;ll ever pay per $1 staked — and the collateral <b>locked per pending
          bet</b> (<span className="hint">reserves ${(p.oddsCap / 1000).toFixed(2)} per $1 until it
          fills</span>). <b>Lower</b> → capital-efficient but you can&apos;t quote big underdogs;{" "}
          <b>higher</b> → quote long shots but tie up cash. <span className="hint">1X2 rarely needs
          &gt; 8×</span>
        </div>
      </label>
      <label>
        <span className="lab">
          Max risk / fixture <b>{p.maxRiskPerFixtureUsdc}</b>
        </span>
        <input type="text" value={p.maxRiskPerFixtureUsdc}
          onChange={(e) => set("maxRiskPerFixtureUsdc", Number(e.target.value) || 0)} />
        <div className="phelp">
          Most you can lose (net) on a <b>single match</b>, in USDC — also the denominator that sets
          how fast skew kicks in (smaller = more defensive). <span className="hint">keep it well
          under your deposit</span>
        </div>
      </label>
      <label>
        <span className="lab">
          Max total risk <b>{p.maxTotalRiskUsdc}</b>
        </span>
        <input type="text" value={p.maxTotalRiskUsdc}
          onChange={(e) => set("maxTotalRiskUsdc", Number(e.target.value) || 0)} />
        <div className="phelp">
          Total you can have locked <b>across all matches</b> at once — your overall book size.{" "}
          <span className="hint">set it near your deposit</span>
        </div>
      </label>
    </>
  );
}

function ExposurePanel({ house, fixtures }: { house: HouseView; fixtures: FixtureRow[] }) {
  const open = house.exposures.filter((e) => e.openBets > 0 || e.locked > 0);
  const name = (id: string) => {
    const f = fixtures.find((f) => String(f.FixtureId) === id);
    return f ? `${f.Participant1} — ${f.Participant2}` : `Fixture #${id}`;
  };
  if (!open.length) return null;
  return (
    <section className="sec">
      <p className="eyebrow">Exposure</p>
      {open.map((e) => {
        const max = Math.max(...e.liability, 1);
        const maxIdx = e.liability.indexOf(Math.max(...e.liability));
        return (
          <div className="panel exp-block" key={e.fixtureId}>
            <div className="exp">
              <div className="exp-fx">{name(e.fixtureId)}</div>
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
                worst case <b>{fmtUsdc(Math.max(...e.liability))}</b> − stakes{" "}
                <b>{fmtUsdc(e.stakesCollected)}</b> = locked <b>{fmtUsdc(e.locked)}</b>
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ---------- all houses (read-only) ----------
const HOUSES_PER_PAGE = 8;
// Wide enough for 7-figure USDC (e.g. 1,000,488.24) without column collision.
const HOUSE_COLS = "1fr 66px 104px 104px 104px";
const numCell = {
  pointerEvents: "none" as const,
  fontSize: 12.5,
  fontVariantNumeric: "tabular-nums" as const,
};

function AllHouses({
  houses,
  fixtures,
  myOwner,
}: {
  houses: HouseView[];
  fixtures: FixtureRow[];
  myOwner: string | null;
}) {
  const [page, setPage] = useState(0);
  const compName = (id: number) => fixtures.find((f) => f.CompetitionId === id)?.Competition ?? `#${id}`;
  const policy = (h: HouseView) => {
    if (!h.filters) return "offers all markets";
    const parts: string[] = [];
    if (h.filters.competitions.length)
      parts.push(
        `${h.filters.competitionAllow ? "only" : "excl"} ${h.filters.competitions.map(compName).join(", ")}`,
      );
    if (h.filters.fixtures.length)
      parts.push(`${h.filters.fixtureAllow ? "only" : "excl"} ${h.filters.fixtures.length} match(es)`);
    return parts.length ? parts.join(" · ") : "offers all markets";
  };

  // Your house is pinned at the top; every other house is listed below it,
  // ordered by size (total deposited) and paginated.
  const mine = myOwner ? houses.find((h) => h.owner === myOwner) ?? null : null;
  const others = houses
    .filter((h) => h.owner !== myOwner)
    .sort((a, b) => b.vault - a.vault);
  const pageCount = Math.max(1, Math.ceil(others.length / HOUSES_PER_PAGE));
  const cur = Math.min(page, pageCount - 1);
  const shown = others.slice(cur * HOUSES_PER_PAGE, cur * HOUSES_PER_PAGE + HOUSES_PER_PAGE);

  const row = (h: HouseView) => (
    <div className="fx" key={h.pda} style={{ gridTemplateColumns: HOUSE_COLS }}>
      <div className="fx-info">
        <div className="fx-teams" style={{ fontSize: 14 }}>
          {h.owner === myOwner ? "★ Your house" : `House ${h.pda.slice(0, 6)}…`}
          {h.paused && <span style={{ color: "var(--stamp)" }}> · paused</span>}
        </div>
        <div className="fx-sub">
          {policy(h)} · odds cap {(h.oddsCap / 1000).toFixed(0)}× · skew {h.skewCoeffBps}bps
        </div>
      </div>
      <div className="pick" style={numCell}>{h.spreadBps}bps</div>
      <div className="pick" style={numCell}>{fmtUsdc(h.vault)}</div>
      <div className="pick" style={numCell}>{fmtUsdc(h.free)}</div>
      <div className="pick" style={numCell}>{fmtUsdc(h.locked)}</div>
    </div>
  );

  return (
    <section className="sec">
      <p className="eyebrow">All houses</p>
      {houses.length === 0 ? (
        <div className="empty">No houses yet.</div>
      ) : (
        <div className="coupon">
          <div className="coupon-head" style={{ gridTemplateColumns: HOUSE_COLS }}>
            <div>House</div>
            <div>Spread</div>
            <div>Vault</div>
            <div>Free</div>
            <div>Locked</div>
          </div>
          {mine && row(mine)}
          {shown.map(row)}
        </div>
      )}
      {pageCount > 1 && (
        <div className="pager">
          <button className="faucet" disabled={cur === 0} onClick={() => setPage(cur - 1)}>
            ← prev
          </button>
          <span>
            page {cur + 1} / {pageCount} · {others.length} other houses by size
          </span>
          <button className="faucet" disabled={cur >= pageCount - 1} onClick={() => setPage(cur + 1)}>
            next →
          </button>
        </div>
      )}
      <p className="annot">
        Houses compete on price — each bet routes to the best odds that can collateralize it. A
        house&apos;s offer policy is published on-chain (the match rule is enforced at commit).
      </p>
    </section>
  );
}
