"use client";
// Solana wallet stack (bolao-copa pattern): @solana/react-hooks SolanaProvider
// with the default client + auto-discovered Wallet-Standard connectors.
// Phantom/Solflare mobile apps register themselves as Wallet-Standard wallets
// that deep-link, so mobile "connect → redirect to the app" works out of the box.
import type { ReactNode } from "react";
import { SolanaProvider } from "@solana/react-hooks";

const RPC =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

function clusterFromRpc(url: string): "devnet" | "testnet" | "mainnet-beta" {
  if (/devnet/i.test(url)) return "devnet";
  if (/testnet/i.test(url)) return "testnet";
  return "mainnet-beta";
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SolanaProvider config={{ cluster: clusterFromRpc(RPC), rpc: RPC }}>
      {children}
    </SolanaProvider>
  );
}
