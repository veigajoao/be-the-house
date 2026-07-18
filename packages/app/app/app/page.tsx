"use client";
// The app shell: masthead + wallet chip + Bet/House tabs. Bets are signed by
// the user's connected wallet (bolao-copa @solana/react-hooks pattern).
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Bettor from "../bettor";
import House from "../house";
import { fmtUsdc, type AppConfig } from "../../lib/types";
import { useBthWallet, useUsdcBalance, WalletPicker, short } from "../../lib/wallet";

export default function App() {
  const wallet = useBthWallet();
  const balance = useUsdcBalance(wallet.address);
  const [tab, setTab] = useState<"bet" | "house">("bet");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [fauceting, setFauceting] = useState(false);
  const [msg, setMsg] = useState("");

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await fetch("/api/config").then((r) => r.json()));
    } catch {
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    const t = setInterval(loadConfig, 30_000);
    return () => clearInterval(t);
  }, [loadConfig]);

  async function faucet(to: string | null) {
    if (!to) {
      wallet.connect();
      return;
    }
    setFauceting(true);
    setMsg("");
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, amountUsdc: 1000 }),
      });
      const body = await res.json();
      if (res.ok) {
        setMsg(`✓ 1000 USDC → ${short(to)}`);
        if (wallet.address && to === wallet.address) void balance.refresh();
      } else {
        setMsg(body.error ?? "airdrop failed");
      }
    } catch (e) {
      setMsg((e as Error).message.slice(0, 90));
    }
    setFauceting(false);
  }

  return (
    <div className="wrap">
      <header className="mast">
        <div>
          <Link href="/" className="logo" style={{ textDecoration: "none", color: "inherit" }}>
            BeThe<span>House</span>
          </Link>
          <div className="tag">Permissionless sportsbook · Solana devnet · TxLINE feed</div>
          <div className="wallet-strip">
            {wallet.connected ? (
              <>
                <span>
                  wallet <b>{short(wallet.address!)}</b>
                </span>
                <span>
                  balance{" "}
                  {balance.loading ? (
                    <b className="loading-note" style={{ display: "inline-flex" }}>
                      <span className="spinner" />
                    </b>
                  ) : (
                    <b>{fmtUsdc(balance.amount)} USDC</b>
                  )}
                </span>
                <button className="faucet" disabled={fauceting} onClick={() => faucet(wallet.address)}>
                  {fauceting ? "funding…" : "+1000 USDC + SOL"}
                </button>
                <button className="faucet" onClick={wallet.disconnect}>
                  disconnect
                </button>
                {msg && (
                  <span style={{ color: msg.startsWith("✓") ? "var(--green)" : "var(--stamp)" }}>
                    {msg}
                  </span>
                )}
              </>
            ) : (
              <button className="faucet" onClick={() => wallet.connect()}>
                connect wallet
              </button>
            )}
          </div>
        </div>
        <div className="mast-meta">
          <Link href="/" style={{ color: "var(--ink-2)" }}>
            ← home
          </Link>
          <br />
          1X2 FULL-TIME · PRE-MATCH ONLY
          <br />
          {config && (
            <>
              program {config.programId.slice(0, 6)}…{config.programId.slice(-4)}
            </>
          )}
        </div>
      </header>

      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === "bet"} onClick={() => setTab("bet")}>
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
        <Bettor config={config} wallet={wallet} onBalanceChange={balance.refresh} />
      </div>
      <div hidden={tab !== "house"}>
        <House wallet={wallet} usdcBalance={balance.amount} onBalanceChange={balance.refresh} />
      </div>

      <WalletPicker wallet={wallet} />
    </div>
  );
}
