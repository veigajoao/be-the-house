# Go-live runbook

Everything runs against **real, live TxLINE mainnet data** on a local surfpool
mainnet fork — real prints, real Merkle proofs, real cloned txoracle roots.
The only simulated things are the SOL/USDC balances.

## 0. Prerequisites (once)

```bash
pnpm install
anchor build
cp .env.example .env   # fill TXLINE_API_TOKEN / TXLINE_JWT
```

- JWT expired? mint a new one: `curl -X POST https://txline.txodds.com/auth/guest/start`
- A fixture must be **pre-match with live StablePrice quoting**. Check candidates:
  ```bash
  npx tsx scripts/capture-fixtures.ts find-finished   # finished games w/ results
  npx tsx scripts/live-e2e.ts                          # auto-picks a quoting fixture
  ```

## 1. The interactive live demo (frontend-driven)

**Terminal A — the whole stack** (surfnet fork + program deploy + protocol init
+ two houses (sharp 80bps / wide 300bps) + API + keeper):

```bash
DEMO_AUTOBET=0 npx tsx scripts/demo.ts <fixtureId>
```

- `DEMO_AUTOBET=0` keeps the script from placing its own bets — you drive it
  from the UI. Drop the flag if you want it to auto-bet on fresh prints.
- Ports: surfnet RPC `19199`, API `8789`.

**Terminal B — the coupon frontend:**

```bash
cd packages/app
RPC_URL=http://127.0.0.1:19199 NEXT_PUBLIC_API_URL=http://127.0.0.1:8789 pnpm dev
```

Open **http://localhost:3123**, then:

1. Hit **+1000 USDC faucet** (top-left).
2. **Bet tab** → tick an outcome on the coupon → slip opens with the "up to"
   ceiling → Place bet.
3. Watch the stub: `Committed` (~15s) → `Odds locked` → `Active` with the
   exact fill odds once the keeper proves both prints (0.5–5.5 min after the
   next 5-min root publication — this delay is the oracle's cadence, not a bug).
4. **House tab**: watch Free/Reserved/Locked move through the same lifecycle,
   and the exposure bars fill.
5. Leave it running through kickoff: when the game finishes, the keeper
   settles automatically and the stub stamps `Won`/`Lost` with the score,
   scores-root and settle-tx receipt.

## 2. The unattended proof (CI-style)

```bash
npx tsx scripts/live-e2e.ts          # commits on fresh prints until one fills
```

Exits 0 with the fill report. Already passed twice (incl. England v Argentina,
which then settled live against the real 1–2).

## 3. The deterministic suite (no live dependency beyond RPC)

```bash
pnpm test        # 71 vitest (replayed real proofs vs cloned roots) + cargo
```

## Swapping the test fixture to the next final

The next final (e.g. Argentina v Spain) isn't in the TxODDS fixtures feed yet.
When it appears:

```bash
npx tsx scripts/capture-fixtures.ts odds <fixtureId>     # pre-match, once quoting starts
npx tsx scripts/capture-fixtures.ts scores <fixtureId>   # after full-time
```

then change `FIXTURE_ID` at the top of `tests/m6-final.test.ts` and update the
two expected fill values (the comments show the formula).

## Devnet deployment (checklist)

The program is already cluster-agnostic — `txoracle_program` and `usdc_mint`
are Config parameters, and the SDK reads `TXORACLE_PROGRAM` / `USDC_MINT` env
overrides. What a devnet deployment needs:

1. **Deploy**: `solana program deploy target/deploy/bethehouse.so -u devnet`
   (airdrop ~4 SOL first).
2. **Test USDC**: `spl-token create-token --decimals 6 -u devnet` (+ mint to
   actors) — set it as `usdc_mint` in `init_config` and `USDC_MINT` env.
3. **init_config** with devnet txoracle `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`,
   and `TXORACLE_PROGRAM` env for SDK/keeper/API.
4. **Devnet TxLINE credentials** — the blocker. Proofs must come from the same
   environment as the roots: `TXLINE_ENV=development` (http://txline-dev.txodds.com),
   a devnet guest JWT, and a devnet-**activated** API token (on-chain
   `subscribe` on the devnet txoracle + `POST /api/token/activate`; the
   richmond panel automates this flow, and a free World Cup tier existed).
5. **Keeper** SOL on devnet; `SURFNET_MODE=false` (no root refresh needed —
   devnet roots are the real, live ones).
6. Frontend: point `RPC_URL` at devnet; this also unlocks a real
   Phantom wallet-adapter integration (Phantom can't reach a localhost fork).

Unverified on devnet: publisher cadence for the devnet roots (mainnet is
5-min; check before promising fill latency in a demo).
