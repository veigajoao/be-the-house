# 🎲 BeTheHouse

Permissionless on-chain sportsbook on Solana. Anyone can *be the house*: post
USDC liquidity with your own spread, risk caps and inventory-skew params.
Bettors commit **blind** to the TxODDS StablePrice at commit+15s; fills and
settlements are verified **on-chain** with Merkle proofs against the
[txoracle](https://txline.txodds.com/documentation) published roots — no
trusted party anywhere in the fill or settlement path.

## How a bet works

1. **commit_bet** — bettor picks fixture/outcome/stake; worst-case collateral
   (`stake × odds_cap`) is reserved from the house *synchronously* (a house
   that can't cover it fails the commit in-wallet; the SDK retries the
   next-best house). Stake + fees + keeper rewards go to escrow.
2. **prove_print** (permissionless crank) — any keeper Merkle-verifies a
   StablePrice print via CPI into txoracle's `validate_odds` and persists a
   tiny `ProvenPrint` account, shared by every bet on that fixture.
3. **fill_bet** (permissionless crank) — reads TWO proven prints: the one
   prevailing at commit and the first at/after commit+15s. Fills at the
   **worse** of the two for the bettor, then house spread/skew, clamped at
   `odds_cap`. Kills latency arbitrage in both directions; fills can never
   fail economically (payout ≤ reservation by construction).
4. **settle_bet** (permissionless crank) — final score proven via
   `validate_stat_v2` against the scores root; stats must come from the
   `game_finalised` event (`period == 100`). Winners are paid from the house
   vault. `refund_commit` / `void_bet` cover oracle silence and abandoned
   games.

**Vault invariant** (checked at every instruction boundary):
`vault_balance ≥ total_locked`, with netting across outcomes — a balanced
book locks ~nothing. House insolvency is structurally impossible.

## Repo layout

```
programs/bethehouse   Anchor program (the protocol)
packages/txline       TxLINE API client
packages/sdk          PDAs, proof mappers, BthClient, reference math
packages/api          Fastify API (/fixtures /quotes /proofs /stream) + keeper
packages/app          Next.js example frontend
tests/                vitest suites vs surfpool mainnet forks (62 tests)
fixtures/             captured real proofs (odds pairs + final scores)
scripts/              capture-fixtures / live-e2e / demo
```

## Running

```bash
pnpm install && anchor build

# full test suite (spawns surfpool mainnet forks; needs network + .env)
pnpm test

# live end-to-end on real TxLINE mainnet data (commit -> prove -> fill)
npx tsx scripts/live-e2e.ts            # auto-picks a quoting fixture

# demo: two houses, best-quote routing, live fill + settle
npx tsx scripts/demo.ts <fixtureId>
# then, in another terminal, the frontend:
cd packages/app && RPC_URL=http://127.0.0.1:19199 pnpm dev
```

`.env` needs `TXLINE_API_TOKEN` + `TXLINE_JWT` (guest JWT from
`POST /auth/guest/start`) and optionally `MAINNET_RPC_URL`.

## Verified live

The unattended e2e has passed against real mainnet data: commit at a live
print (ceiling 1.759) → keeper proved both prints ~10 s after txoracle
published the batch root → filled at 1.706 (adverse drift; worse-of-two
working as designed) → payout 8.53 USDC on a 5 USDC stake at Argentina v
Switzerland.

## Design notes / deviations from the original spec

- **Two-crank fill via `ProvenPrint`**: one odds proof is ~770 bytes; two can
  never fit a 1232-byte tx. Prints are proven once (v0 tx + address lookup
  table) and shared across bets — cheaper for keepers than per-bet proofs.
- **Keeper rewards**: 2 per bet (fill + settle/void), escrowed at commit;
  print-proving is compensated by rent-reclaim + being a prerequisite of the
  rewarded fill.
- **`void_bet` refunds stake only** — fees already distributed at fill are
  not clawed back (hackathon scope).
- Timestamps are **milliseconds** end-to-end; odds ×1000; USDC 6dp; floor
  rounding everywhere. `payload.ts` for stat proofs must equal
  `updateStats.minTimestamp` (txoracle slot-seed rule).

Out of scope (deliberately): keeper print-selection disputes/slashing, bet
splitting, OU/AH markets, in-running, LP share pools, mainnet deployment.
