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

  async function faucet() {
    setFauceting(true);
    await fetch("/api/faucet", { method: "POST" });
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
                <button className="faucet" disabled={fauceting} onClick={faucet}>
                  {fauceting ? "minting…" : "+1000 USDC faucet"}
                </button>
              </>
            ) : (
              <span>connecting…</span>
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
