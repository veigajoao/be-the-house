"use client";
// Shell: masthead + wallet strip + Bet/House tabs (football-pools coupon
// visual direction — see .context design spec).
import { useCallback, useEffect, useState } from "react";
import Bettor from "./bettor";
import House from "./house";
import { fmtUsdc, type AppConfig } from "../lib/types";

export default function App() {
  const [tab, setTab] = useState<"bet" | "house">("bet");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [fauceting, setFauceting] = useState(false);
  const [airdropTo, setAirdropTo] = useState("");
  const [airdropMsg, setAirdropMsg] = useState("");

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await fetch("/api/config").then((r) => r.json()));
    } catch {
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    const t = setInterval(loadConfig, 10_000);
    return () => clearInterval(t);
  }, [loadConfig]);

  async function faucet(to?: string) {
    setFauceting(true);
    setAirdropMsg("");
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(to ? { to, amountUsdc: 1000 } : {}),
      });
      const body = await res.json();
      if (!res.ok) setAirdropMsg(body.error ?? "airdrop failed");
      else if (to) setAirdropMsg(`✓ 1000 USDC → ${to.slice(0, 4)}…${to.slice(-4)}`);
    } catch (e) {
      setAirdropMsg((e as Error).message.slice(0, 80));
    }
    await loadConfig();
    setFauceting(false);
  }

  return (
    <div className="wrap">
      <header className="mast">
        <div>
          <div className="logo">
            BeThe<span>House</span>
          </div>
          <div className="tag">Permissionless sportsbook · Solana · TxLINE feed</div>
          <div className="wallet-strip">
            {config ? (
              <>
                <span>
                  wallet <b>{config.bettor.slice(0, 4)}…{config.bettor.slice(-4)}</b>
                </span>
                <span>
                  balance <b>{fmtUsdc(config.bettorUsdc)} USDC</b>
                </span>
                <button className="faucet" disabled={fauceting} onClick={() => faucet()}>
                  {fauceting ? "minting…" : "+1000 USDC faucet"}
                </button>
              </>
            ) : (
              <span>connecting…</span>
            )}
          </div>
          <div className="wallet-strip">
            <input
              value={airdropTo}
              onChange={(e) => setAirdropTo(e.target.value)}
              placeholder="airdrop 1000 USDC to any wallet…"
              aria-label="Airdrop destination wallet"
              style={{
                background: "var(--card)",
                border: "1px solid var(--rule)",
                color: "var(--ink)",
                fontFamily: "var(--mono)",
                fontSize: 11,
                padding: "3px 8px",
                width: 300,
              }}
            />
            <button
              className="faucet"
              disabled={fauceting || !airdropTo.trim()}
              onClick={() => faucet(airdropTo.trim())}
            >
              airdrop
            </button>
            {airdropMsg && (
              <span style={{ color: airdropMsg.startsWith("✓") ? "var(--green)" : "var(--stamp)" }}>
                {airdropMsg}
              </span>
            )}
          </div>
        </div>
        <div className="mast-meta">
          1X2 FULL-TIME · PRE-MATCH ONLY
          <br />
          USDC · SURFNET DEMO
          <br />
          {config && (
            <>
              program {config.programId.slice(0, 6)}…{config.programId.slice(-4)}
            </>
          )}
        </div>
      </header>

      <div className="tabs" role="tablist">
        <button
          className="tab"
          role="tab"
          aria-selected={tab === "bet"}
          onClick={() => setTab("bet")}
        >
          Bet
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={tab === "house"}
          onClick={() => setTab("house")}
        >
          House
        </button>
      </div>

      <div hidden={tab !== "bet"}>
        <Bettor config={config} />
      </div>
      <div hidden={tab !== "house"}>
        <House />
      </div>
    </div>
  );
}
