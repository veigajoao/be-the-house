"use client";
// Wallet UX ported from bolao-copa's @solana/react-hooks pattern, adapted to
// BeTheHouse: no SIWS/auth — the connected wallet just signs its own bet
// commit transactions (built unsigned by the server). Mobile deep-linking is
// automatic via Wallet-Standard (Phantom/Solflare register redirecting wallets).
import { useCallback, useRef, useState } from "react";
import {
  useWalletModalState,
  useWalletSession,
  useSplToken,
} from "@solana/react-hooks";
import type { WalletSession } from "@solana/client";
import { getBase64Encoder, getTransactionDecoder } from "@solana/kit";

const USDC_MINT =
  process.env.NEXT_PUBLIC_USDC_MINT ?? "ETnaYN2P3WnH1ZRgCVPbGmNsZ3g7DuJwX8t77czxAyw6";

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Decode a server-built unsigned tx (base64) and hand it to the wallet to
 * sign & send — on mobile this redirects to the wallet app. */
async function signAndSend(session: WalletSession, base64: string): Promise<string> {
  const bytes = getBase64Encoder().encode(base64);
  const tx = getTransactionDecoder().decode(bytes);
  if (!session.sendTransaction) {
    throw new Error("This wallet can't sign & send — try Phantom or Solflare.");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sig = await session.sendTransaction(tx as any);
  return String(sig);
}

export function useBthWallet() {
  const modal = useWalletModalState({ closeOnConnect: true });
  const session = useWalletSession();
  const [busy, setBusy] = useState(false);
  const afterConnect = useRef<(() => void) | null>(null);

  const address = session?.account.address.toString() ?? null;

  const connect = useCallback(
    (then?: () => void) => {
      if (session) {
        then?.();
        return;
      }
      afterConnect.current = then ?? null;
      modal.open();
    },
    [session, modal],
  );

  const pick = useCallback(
    async (connectorId: string) => {
      try {
        await modal.connect(connectorId);
        const cb = afterConnect.current;
        afterConnect.current = null;
        cb?.();
      } catch (e) {
        afterConnect.current = null;
        throw e;
      }
    },
    [modal],
  );

  const disconnect = useCallback(() => modal.disconnect().catch(() => {}), [modal]);

  const sign = useCallback(
    async (base64Tx: string): Promise<string> => {
      if (!session) throw new Error("connect a wallet first");
      setBusy(true);
      try {
        return await signAndSend(session, base64Tx);
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  return { modal, address, connected: !!session, busy, connect, pick, disconnect, sign };
}

/** USDC balance of the connected wallet (base units → number). */
export function useUsdcBalance(owner: string | null): number {
  const usdc = useSplToken(USDC_MINT, owner ? { owner } : { owner: USDC_MINT });
  if (!owner || !usdc.balance) return 0;
  return Number(usdc.balance.amount);
}

// ---- picker dialog (styled to the coupon aesthetic) ----
export function WalletPicker({ wallet }: { wallet: ReturnType<typeof useBthWallet> }) {
  const { modal, pick } = wallet;
  const [busy, setBusy] = useState(false);
  if (!modal.isOpen) return null;
  const available = modal.connectors.filter((c) => c.ready !== false);

  return (
    <div
      onClick={() => modal.close()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(22,31,42,.4)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--card)", border: "1px solid var(--ink)", width: 320 }}
      >
        <div className="slip-head">
          <span>Connect wallet</span>
          <button className="slip-x" aria-label="Close" onClick={() => modal.close()}>
            ×
          </button>
        </div>
        <div className="slip-body" style={{ display: "grid", gap: 8 }}>
          {available.length === 0 && (
            <a className="btn" href="https://phantom.com/download" target="_blank" rel="noreferrer">
              Install Phantom
            </a>
          )}
          {available.map((c) => (
            <button
              key={c.id}
              className="btn"
              disabled={busy || modal.connecting}
              style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-start" }}
              onClick={async () => {
                setBusy(true);
                try {
                  await pick(c.id);
                } catch {
                  /* user rejected / connect error */
                } finally {
                  setBusy(false);
                }
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {c.icon && <img src={c.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} />}
              {c.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
