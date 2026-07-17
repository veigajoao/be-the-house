// Permissionless keeper: watches Pending/Active bets and cranks
// prove_print -> fill_bet -> settle_bet (or refund/void) with proofs
// relayed from TxLINE.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import {
  BthClient,
  oddsRootPda,
  scoresRootPda,
  USDC_MINT,
  type BetAccount,
} from "@bethehouse/sdk";
import {
  MARKET_1X2,
  STABLE_PRICE_BOOKMAKER_ID,
  TxLineClient,
  TxLineError,
  type OddsRecord,
} from "@bethehouse/txline";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[keeper]", ...a);

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
        if (nowMs > targetTs + 3_600_000) {
          await this.tryRefund(publicKey, account);
        } else if (nowMs >= targetTs) {
          await this.tryFill(publicKey, account, commitTs, targetTs);
        }
      } else if (state === "active") {
        active++;
        await this.trySettle(publicKey, account);
      }
    }
    return { bets: bets.length, pending, active };
  }

  /** Pick the commit print (latest <= commit_ts) and target print (earliest >= target_ts). */
  private async pickPrints(
    fixtureId: number,
    commitTs: number,
    targetTs: number,
  ): Promise<{ commit: OddsRecord; target: OddsRecord } | null> {
    const updates = (await this.txline.oddsUpdates(fixtureId)).filter(
      (r) =>
        r.SuperOddsType === MARKET_1X2 &&
        r.BookmakerId === STABLE_PRICE_BOOKMAKER_ID &&
        !r.MarketPeriod &&
        !r.InRunning,
    );
    const commitCandidates = updates
      .filter((r) => r.Ts <= commitTs && r.Ts >= commitTs - 120_000)
      .sort((a, b) => b.Ts - a.Ts);
    const targetCandidates = updates
      .filter((r) => r.Ts >= targetTs && r.Ts <= targetTs + 90_000)
      .sort((a, b) => a.Ts - b.Ts);
    if (!commitCandidates.length || !targetCandidates.length) return null;
    return { commit: commitCandidates[0], target: targetCandidates[0] };
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

  private async tryFill(
    betPda: PublicKey,
    bet: BetAccount,
    commitTs: number,
    targetTs: number,
  ): Promise<void> {
    const fixtureId = Number(bet.fixtureId);
    const prints = await this.pickPrints(fixtureId, commitTs, targetTs);
    if (!prints) {
      log(`bet ${betPda.toBase58().slice(0, 8)}: no qualifying prints in the fill windows yet`);
      return; // (oracle silence -> expiry refund eventually)
    }

    // proofs 404 until the 5-min batch root is published (~35s past boundary)
    let commitProof, targetProof;
    try {
      [commitProof, targetProof] = await Promise.all([
        this.txline.oddsValidation(prints.commit.MessageId, prints.commit.Ts),
        this.txline.oddsValidation(prints.target.MessageId, prints.target.Ts),
      ]);
    } catch (e) {
      if (e instanceof TxLineError && e.status === 404) {
        log(`bet ${betPda.toBase58().slice(0, 8)}: proofs not yet published, waiting`);
        return;
      }
      throw e;
    }

    const roots = [oddsRootPda(prints.commit.Ts), oddsRootPda(prints.target.Ts)];
    for (const r of roots) await this.refreshRoot(r);
    const lut = await this.ensureLut(roots);

    for (const proof of [commitProof, targetProof]) {
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
      prints.target.Ts,
    );
    log(`filled bet ${betPda.toBase58().slice(0, 8)} (${sig.slice(0, 8)})`);
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
