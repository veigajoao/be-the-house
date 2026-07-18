// The wallet/RPC provider is scoped to the /app subtree so the marketing
// landing page ("/") stays lean (no @solana/kit + react-hooks bundle).
import type { ReactNode } from "react";
import { Providers } from "../providers";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
