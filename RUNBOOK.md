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
+ two houses (sharp 80bps / wide 300bps) + in-process keeper):

```bash
DEMO_AUTOBET=0 npx tsx scripts/demo.ts <fixtureId>
```

- `DEMO_AUTOBET=0` keeps the script from placing its own bets — you drive it
  from the UI. Drop the flag if you want it to auto-bet on fresh prints.
- Surfnet RPC: `19199`. (No separate API process — the app serves its own.)

**Terminal B — the coupon frontend (serves the API routes too):**

```bash
cd packages/app
RPC_URL=http://127.0.0.1:19199 SURFNET_MODE=true pnpm dev
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

## Vercel deployment (single Next.js app)

The Fastify service is retired: `/fixtures`, `/quotes`, and the proof relays
are Next route handlers (same-origin — no CORS), the odds stream is polling
(the UI already polls every 5s), and **the keeper is a Vercel Cron** hitting
`/api/cron/keeper` every minute (`packages/app/vercel.json`). One-minute
ticks are fine: fill latency is dominated by the oracle's 5-minute root
cadence.

- Vercel project root: `packages/app` (pnpm monorepo — workspace deps build
  via `transpilePackages`).
- Env vars: `RPC_URL`, `TXLINE_ENV=development`, `TXLINE_DEV_JWT`,
  `TXLINE_DEV_API_TOKEN`, `TXORACLE_PROGRAM`, `USDC_MINT`,
  `DEMO_KEYPAIR_JSON` (the keypair JSON array — demo bettor + keeper + mint
  authority), `SURFNET_MODE=false`, `CRON_SECRET` (recommended; the route
  checks `Authorization: Bearer`).
- ⚠ Every-minute crons need Vercel **Pro** (Hobby caps crons at daily).
  On Hobby, point any external pinger (e.g. cron-job.org) at
  `/api/cron/keeper` with the bearer secret — the route is a plain GET.
- After `anchor build`, re-sync the app's bundled IDL:
  `cp target/idl/bethehouse.json packages/app/lib/idl/`.
- Local single-process run (replaces the two-terminal flow):
  ```bash
  cd packages/app && RPC_URL=... TXLINE_ENV=development SURFNET_MODE=false \
  TXORACLE_PROGRAM=6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J \
  USDC_MINT=ETnaYN2P3WnH1ZRgCVPbGmNsZ3g7DuJwX8t77czxAyw6 pnpm dev
  # keeper locally: hit the cron route on an interval
  while true; do curl -s http://127.0.0.1:3123/api/cron/keeper; sleep 20; done
  ```

### Devnet fill windows (widened 2026-07-17)

Devnet StablePrice quoting gaps ~30 min between bursts, so the on-chain fill
windows were widened via `update_config` (no redeploy — they're Config
params): `staleness_window_ms` 120s → **2h**, `fill_tolerance_ms` 90s →
**2h**, `commit_expiry_ms` 1h → **3h** (target window must exceed the worst
observed ~50min print gap). A bet placed during a lull fills from the last print (commit side)
and the next burst (target side); worst case ~50 min to fill, inside the 1h
refund expiry. Mainnet/surfnet keep the spec-tight 120s/90s. The UI quotes
from prints up to 2h old and labels their age.

## Wallet connect (real user wallets)

Bets are signed by the user's own wallet (Phantom/Solflare), ported from
bolao-copa's `@solana/react-hooks` pattern. The demo keypair is now only the
server's role (keeper cranks + faucet mint authority + unsigned-tx builder).

Flow: **Connect wallet** (masthead) → **faucet** mints 1000 test USDC *and*
tops up 0.05 devnet SOL (fees + bet-account rent) to the connected wallet →
tick an outcome → **Place bet**: the server builds an unsigned `commit_bet`
tx (routing to a house that can fill, via simulation), the wallet signs & sends
it (mobile → redirects to the wallet app). "My bets" filters by the connected
address (`getProgramAccounts` memcmp on `Bet.bettor`).

Client env for the wallet provider: `NEXT_PUBLIC_RPC_URL`,
`NEXT_PUBLIC_USDC_MINT` (dev command sets both). Mobile deep-linking needs no
config — Phantom/Solflare register Wallet-Standard wallets that redirect.
