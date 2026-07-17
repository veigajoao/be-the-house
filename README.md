# 🎲 BeTheHouse

Permissionless on-chain sportsbook on Solana. Anyone can *be the house*: post
USDC liquidity with your own spread, risk caps and inventory-skew params.
Bettors commit **blind** to the TxODDS StablePrice at commit+15s; fills and
settlements are verified **on-chain** with Merkle proofs against the
[txoracle](https://txline.txodds.com/documentation) published roots — no
trusted party anywhere in the fill or settlement path.

## The core idea: oracle price + inventory skew

**The whole point of the protocol is this pricing loop.** An oracle tells
everyone the fair price; each liquidity pool (house) quotes that price shaded
by *how imbalanced its own book is*. The more one-sided the pool's exposure,
the worse the price it shows on the heavy side — which steers new flow to the
light side and pulls the book back toward balance.

**1 — The oracle sets the fair price.** TxODDS's *StablePrice* engine
aggregates sharp bookmakers into a demargined consensus price for each
outcome. Every print is Merkle-committed on-chain by the txoracle program, so
`fair_odds(o)` is not an input anyone (including us) can fudge — fills verify
it cryptographically.

**2 — The pool shades it by spread + skew.** What a house actually quotes is:

```
skew_bps(o) = skew_coeff_bps × (liability[o] − min(liability)) / max_risk_per_fixture

quoted(o)   = fair_odds(o) × (10000 − spread_bps − skew_bps(o)) / 10000
              …clamped at odds_cap
```

`liability[o]` is what the pool would pay out if outcome `o` hits. So
`liability[o] − min(liability)` is exactly **how lopsided the book is toward
that outcome** — the gap between the oracle's price and the pool's price *is*
a direct function of the pool's imbalance. A balanced book quotes
`fair × (1 − spread)` on every outcome; a book heavy on Home quotes Home
worse (and only Home — skew never touches the lightest side).

**3 — The fill can't be gamed.** The bet fills at the *worse* of the quote at
commit time and the quote 15 seconds later (`min` of the two, both
Merkle-proven), so neither the bettor nor the house can snipe a stale price.

**4 — Why balance pays.** Locked collateral per fixture is
`max(liability) − stakes_collected` (netted, floored at 0): a balanced book
locks almost nothing, an imbalanced one locks the whole gap. Skew is the
force that pushes every pool toward the cheap, balanced state.

### Worked example

Book: `liability = [900, 100, 100]` USDC (heavy on Home),
`skew_coeff = 5000 bps`, `max_risk_per_fixture = 1000`, `spread = 100 bps`,
oracle Home odds `2.000`:

```
skew(Home)   = 5000 × (900 − 100) / 1000 = 4000 bps
quoted(Home) = 2.000 × (10000 − 100 − 4000)/10000 = 1.180   ← heavy side, much worse
skew(Draw)   = skew(Away) = 0
quoted(Away) = fair(Away) × 0.99                            ← light side, full price
```

Home backers now get a terrible price here (routing sends them to a more
balanced pool); Away/Draw backers get nearly fair odds — exactly the flow
this book needs.

### The knobs an LP tunes

| Parameter | What it controls | Tuning intuition |
|---|---|---|
| `spread_bps` | Baseline edge over the oracle price on **every** fill | Tighter wins more routed flow at thinner margin — you're bidding against every other house |
| `skew_coeff_bps` | How hard the quote responds to imbalance (slope of skew) | Higher = book self-balances faster but goes uncompetitive sooner; 0 = you're happy warehousing one-sided risk |
| `max_risk_per_fixture` | The skew **denominator** and hard cap on net one-game loss | Smaller = the same imbalance produces more skew (more defensive); read it as "how much exposure makes me max out" |
| `odds_cap` | Max odds paid; also collateral reserved per pending bet (`stake × odds_cap`) | High cap quotes long shots but ties up capital between commit and fill; low cap is capital-efficient |
| `max_total_risk` | Ceiling on locked collateral across all fixtures | Overall book size vs. vault |

Everything above is enforced on-chain (`programs/bethehouse/src/math.rs`,
mirrored 1:1 in `packages/sdk/src/math.ts` and pinned by property tests).

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
The devnet deployment (addresses + start commands) is in `RUNBOOK.md`.

### Funding test USDC (faucet / airdrops)

The protocol uses a test USDC mint whose authority is the demo admin, so
funding is instant and unlimited — three ways:

- **Faucet button** (masthead) — tops up the site's demo wallet by 1000 USDC.
- **Airdrop box** (masthead) — paste **any wallet address** and hit *airdrop*
  to mint it 1000 USDC; use this to fund users who want to bet.
- **CLI** — `npx tsx scripts/airdrop-usdc.ts <wallet> [amount]` (devnet,
  operator-side; also callable as `POST /api/faucet {"to": "...", "amountUsdc": n}`).

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
