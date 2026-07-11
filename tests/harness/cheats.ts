import type { Connection, PublicKey } from "@solana/web3.js";

/** Raw JSON-RPC call for surfpool's surfnet_* cheatcodes. */
async function rpc<T>(connection: Connection, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result as T;
}

/**
 * Move the surfnet clock FORWARD to an absolute unix timestamp in ms.
 * Backward travel is not supported by surfpool (verified on 1.3.1) — for
 * aligning bets with historical oracle proofs, patch the Bet account's
 * timestamps instead (see setup.ts `patchAccountData`).
 */
export async function timeTravel(connection: Connection, tsMs: number): Promise<void> {
  await rpc(connection, "surfnet_timeTravel", [{ absoluteTimestamp: tsMs }]);
}

export async function pauseClock(connection: Connection): Promise<void> {
  await rpc(connection, "surfnet_pauseClock", []);
}

export async function resumeClock(connection: Connection): Promise<void> {
  await rpc(connection, "surfnet_resumeClock", []);
}

/** Set (or create) an SPL token account with an arbitrary balance. */
export async function setTokenAccount(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: bigint | number,
): Promise<void> {
  await rpc(connection, "surfnet_setTokenAccount", [
    owner.toBase58(),
    mint.toBase58(),
    { amount: Number(amount) },
  ]);
}

/**
 * Overwrite any account. `data` must be HEX-encoded (surfpool 1.3.1 rejects
 * base64). Used to patch Bet timestamps for historical-proof replay and to
 * refresh cloned oracle roots.
 */
export async function setAccount(
  connection: Connection,
  pubkey: PublicKey,
  account: { lamports?: number; owner?: string; data?: string; executable?: boolean },
): Promise<void> {
  await rpc(connection, "surfnet_setAccount", [pubkey.toBase58(), account]);
}

/** Read an account, apply `patch` to its raw data, write it back. */
export async function patchAccountData(
  connection: Connection,
  pubkey: PublicKey,
  patch: (data: Buffer) => void,
): Promise<void> {
  const info = await connection.getAccountInfo(pubkey);
  if (!info) throw new Error(`patchAccountData: ${pubkey.toBase58()} not found`);
  const data = Buffer.from(info.data);
  patch(data);
  await setAccount(connection, pubkey, { data: data.toString("hex") });
}

/** List available cheatcodes (debugging aid). */
export async function listCheatcodes(connection: Connection): Promise<unknown> {
  return rpc(connection, "surfnet_cheatcodes", []);
}
