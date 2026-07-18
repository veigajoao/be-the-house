// Permissionless keeper: watches Pending/Active bets and cranks
// prove_print -> fill_bet -> settle_bet (or refund/void) with proofs
// relayed from TxLINE.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import { BthClient, type BetAccount } from "./client.js";
import { oddsRootPda, scoresRootPda, USDC_MINT } from "./pdas.js";
import {
  MARKET_1X2,
  STABLE_PRICE_BOOKMAKER_ID,
  TxLineClient,
  TxLineError,
  type OddsRecord,
} from "@bethehouse/txline";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[keeper]", ...a);

// Search windows — mirror the on-chain Config so the keeper never picks a print
// the program would reject. Generous by design for devnet's bursty feed.
const COMMIT_LOOKBACK_MS = 7_200_000; // <= config.staleness_window_ms (2h)
const FILL_TOLERANCE_MS = 7_200_000; // <= config.fill_tolerance_ms (2h)
// How long past target to wait for a genuinely fresher print (preserving the
// worse-of-two anti-snipe on a healthy feed) before falling back to the commit
// price. ~mainnet cadence; on devnet the fallback then carries the fill.
const FRESH_GRACE_MS = 300_000;
// Refund is the true-outage safety net only (matches config.commit_expiry_ms, 3h).
const COMMIT_EXPIRY_MS = 10_800_000;

export interface KeeperOptions {
  /** true when the RPC is a surfpool fork: refresh oracle roots before proving. */
  surfnetMode: boolean;
  /** real mainnet RPC used only for surfnet root refresh. */
  mainnetRpcUrl?: string;
  /** run() loop interval; irrelevant for one-shot tick() (Vercel Cron). */
  intervalMs?: number;
}

export class Keeper {
  private lut: AddressLookupTableAccount | null = null;
  private mainnet: Connection;
  private crankerToken: PublicKey;
  private stopped = false;
  private ataChecked = false;

  constructor(
    private client: BthClient,
    private txline: TxLineClient,
    private opts: KeeperOptions = { surfnetMode: false },
  ) {
    this.crankerToken = getAssociatedTokenAddressSync(USDC_MINT, client.signer.publicKey);
    this.mainnet = new Connection(
      opts.mainnetRpcUrl ?? "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
  }

  stop() {
    this.stopped = true;
  }

  async run(): Promise<void> {
    log("keeper started; cranker:", this.client.signer.publicKey.toBase58());
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (e) {
        log("tick error:", (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, this.opts.intervalMs ?? 5_000));
    }
  }

  private async ensureCrankerAta(): Promise<void> {
    if (await this.client.connection.getAccountInfo(this.crankerToken)) return;
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      this.client.signer.publicKey,
      this.crankerToken,
      this.client.signer.publicKey,
      USDC_MINT,
    );
    const tx = new Transaction().add(ix);
    const { blockhash } = await this.client.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.client.signer.publicKey;
    tx.sign(this.client.signer);
    const sig = await this.client.connection.sendRawTransaction(tx.serialize());
    await this.client.connection.confirmTransaction(sig, "confirmed");
    log("created cranker USDC ATA", this.crankerToken.toBase58());
  }

  // Public devnet RPC rate-limits getProgramAccounts hard, so full discovery
  // runs only every DISCOVERY_EVERY ticks; in between, known bets are polled
  // with cheap getMultipleAccounts calls.
  private known = new Set<string>();
  private tickCount = 0;
  private static DISCOVERY_EVERY = 5;

  private async fetchBets(): Promise<{ publicKey: PublicKey; account: BetAccount }[]> {
    this.tickCount++;
    if (this.known.size === 0 || this.tickCount % Keeper.DISCOVERY_EVERY === 1) {
      const all = await (this.client.program.account as any).bet.all();
      this.known = new Set(all.map((b: any) => b.publicKey.toBase58()));
      return all;
    }
    const keys = [...this.known].map((k) => new PublicKey(k));
    const out: { publicKey: PublicKey; account: BetAccount }[] = [];
    const coder = this.client.program.coder.accounts;
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const infos = await this.client.connection.getMultipleAccountsInfo(chunk);
      infos.forEach((info, j) => {
        if (info) out.push({ publicKey: chunk[j], account: coder.decode("bet", info.data) });
        else this.known.delete(chunk[j].toBase58()); // closed account
      });
    }
    return out;
  }

  /** One keeper pass; safe to call from a cron. Returns a small summary. */
  async tick(): Promise<{ bets: number; pending: number; active: number }> {
    // reward destination must exist before the first fill/settle crank
    if (!this.ataChecked) {
      await this.ensureCrankerAta();
      this.ataChecked = true;
    }
    const bets = await this.fetchBets();
    const nowMs = Date.now();
    let pending = 0;
    let active = 0;

    for (const { publicKey, account } of bets as { publicKey: PublicKey; account: BetAccount }[]) {
      const state = Object.keys(account.state)[0];
      if (state === "pending") {
        pending++;
        const targetTs = Number(account.targetTsMs);
        const commitTs = Number(account.commitTsMs);
        if (nowMs >= targetTs) {
          // Always try to fill first (the fallback fills even during a lull);
          // only refund if a fill was impossible AND the bet has truly expired.
          const filled = await this.tryFill(publicKey, account, commitTs, targetTs);
          if (!filled && nowMs > targetTs + COMMIT_EXPIRY_MS) {
            await this.tryRefund(publicKey, account);
          }
        }
      } else if (state === "active") {
        active++;
        await this.trySettle(publicKey, account);
      }
    }
    return { bets: bets.length, pending, active };
  }

  /**
   * Pick the two prints for the fill:
   *  - commit: latest proven print at/before commit_ts (within staleness).
   *  - target: earliest genuine print at/after target_ts (worse-of-two). If the
   *    feed stayed silent past target_ts + FRESH_GRACE_MS, FALL BACK to the
   *    commit print itself (fill at the last proven price).
   * Returns null only when there is no commit-side print at all (true oracle
   * silence -> eventual refund) or while still within the fresh-print grace.
   */
  private async pickPrints(
    fixtureId: number,
    commitTs: number,
    targetTs: number,
    nowMs: number,
  ): Promise<{ commit: OddsRecord; target: OddsRecord; fallback: boolean } | null> {
    const updates = (await this.txline.oddsUpdates(fixtureId)).filter(
      (r) =>
        r.SuperOddsType === MARKET_1X2 &&
        r.BookmakerId === STABLE_PRICE_BOOKMAKER_ID &&
        !r.MarketPeriod &&
        !r.InRunning,
    );
    const commit = updates
      .filter((r) => r.Ts <= commitTs && r.Ts >= commitTs - COMMIT_LOOKBACK_MS)
      .sort((a, b) => b.Ts - a.Ts)[0];
    if (!commit) return null; // no proven commit price -> true outage

    // A genuinely fresher print at/after target (keeps worse-of-two live).
    const target = updates
      .filter((r) => r.Ts > commit.Ts && r.Ts >= targetTs && r.Ts <= targetTs + FILL_TOLERANCE_MS)
      .sort((a, b) => a.Ts - b.Ts)[0];
    if (target) return { commit, target, fallback: false };

    // None yet: wait out the grace for a fresh print, then fall back to commit.
    if (nowMs < targetTs + FRESH_GRACE_MS) return null;
    return { commit, target: commit, fallback: true };
  }

  /** Surfnet mode: copy the current mainnet root account into the fork
   * (surfpool caches cloned accounts while mainnet roots mutate every 5 min). */
  private async refreshRoot(root: PublicKey): Promise<void> {
    if (!this.opts.surfnetMode) return;
    const info = await this.mainnet.getAccountInfo(root);
    if (!info) return;
    await fetch(this.client.connection.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_setAccount",
        params: [
          root.toBase58(),
          {
            lamports: info.lamports,
            owner: info.owner.toBase58(),
            data: Buffer.from(info.data).toString("hex"),
            executable: false,
          },
        ],
      }),
    });
  }

  private async ensureLut(roots: PublicKey[]): Promise<AddressLookupTableAccount> {
    if (!this.lut) {
      this.lut = await this.client.createProveLut(roots);
    } else {
      this.lut = await this.client.extendLut(this.lut, roots);
    }
    return this.lut;
  }

  /** Returns true once the bet is filled (so the caller won't try to refund). */
  private async tryFill(
    betPda: PublicKey,
    bet: BetAccount,
    commitTs: number,
    targetTs: number,
  ): Promise<boolean> {
    const fixtureId = Number(bet.fixtureId);
    const prints = await this.pickPrints(fixtureId, commitTs, targetTs, Date.now());
    if (!prints) {
      log(`bet ${betPda.toBase58().slice(0, 8)}: waiting for a proven price (commit-side or fresher target)`);
      return false;
    }

    // In the fallback the commit print serves both sides — prove it once.
    const records = prints.fallback ? [prints.commit] : [prints.commit, prints.target];
    // proofs 404 until the 5-min batch root is published (~35s past boundary)
    let proofs;
    try {
      proofs = await Promise.all(
        records.map((r) => this.txline.oddsValidation(r.MessageId, r.Ts)),
      );
    } catch (e) {
      if (e instanceof TxLineError && e.status === 404) {
        log(`bet ${betPda.toBase58().slice(0, 8)}: proofs not yet published, waiting`);
        return false;
      }
      throw e;
    }

    const roots = [...new Set(records.map((r) => oddsRootPda(r.Ts).toBase58()))].map(
      (s) => new PublicKey(s),
    );
    for (const r of roots) await this.refreshRoot(r);
    const lut = await this.ensureLut(roots);

    for (const proof of proofs) {
      const sig = await this.client.provePrint(proof, lut);
      if (sig) log(`proved print ts=${proof.odds.Ts} (${sig.slice(0, 8)})`);
    }

    const house = await (this.client.program.account as any).house.fetch(bet.house);
    const frontend = await (this.client.program.account as any).frontend.fetch(bet.frontend);
    const sig = await this.client.fillBet(
      betPda,
      bet,
      { vault: house.vault },
      { feeVault: frontend.feeVault },
      this.crankerToken,
      prints.commit.Ts,
      prints.target.Ts, // == commit.Ts in the fallback -> same ProvenPrint account
    );
    log(
      `filled bet ${betPda.toBase58().slice(0, 8)} ` +
        `(${prints.fallback ? "fallback: last proven price" : "worse-of-two"}) (${sig.slice(0, 8)})`,
    );
    return true;
  }

  private async trySettle(betPda: PublicKey, bet: BetAccount): Promise<void> {
    const fixtureId = Number(bet.fixtureId);
    let events;
    try {
      events = await this.txline.scoresSnapshot(fixtureId);
    } catch {
      return; // no scores coverage yet
    }
    const finalised = events.find((e) => e.Action === "game_finalised");
    if (!finalised) return;

    const proof = await this.txline.statValidation(fixtureId, finalised.Seq, [1, 2]);
    await this.refreshRoot(scoresRootPda(proof.summary.updateStats.minTimestamp));

    const house = await (this.client.program.account as any).house.fetch(bet.house);
    const bettorToken = getAssociatedTokenAddressSync(USDC_MINT, bet.bettor);
    const sig = await this.client.settleBet(
      betPda,
      bet,
      { vault: house.vault },
      bettorToken,
      this.crankerToken,
      proof,
    );
    log(`settled bet ${betPda.toBase58().slice(0, 8)} (${sig.slice(0, 8)})`);
  }

  private async tryRefund(betPda: PublicKey, bet: BetAccount): Promise<void> {
    const bettorToken = getAssociatedTokenAddressSync(USDC_MINT, bet.bettor);
    try {
      const sig = await this.client.refundCommit(betPda, bet, bettorToken);
      log(`refunded expired bet ${betPda.toBase58().slice(0, 8)} (${sig.slice(0, 8)})`);
    } catch (e) {
      // NotExpired etc. — leave for a later tick
      log(`refund not yet possible for ${betPda.toBase58().slice(0, 8)}`);
    }
  }
}
