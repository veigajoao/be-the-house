# 🎲 BeTheHouse

### A permissionless on-chain sportsbook on Solana. No bookmaker. Anyone bets, anyone *is* the house, anyone ships a frontend.

Traditional sportsbooks are a black box: the operator sets the lines, holds
your money, takes the edge, and decides who's allowed to play. **BeTheHouse
turns every one of those roles into open infrastructure.** Prices come from a
cryptographic oracle, liquidity comes from anyone willing to post USDC, and
every fill and settlement is *proven on-chain* — there is no trusted party
anywhere in the loop.

> **Live on Solana devnet.** Program `51bQ1HLbg7urERU7TU8E2KZsSnnniCLLmE9eTMetgH4A` ·
> demo book seeded with a **1,000,000 USDC** house · real World-Cup prices from
> the TxODDS feed.

---

## Why this is different

### 🔒 1. Trustless prices — commit blind, fill on *proven* oracle prints
You never take a price a bookmaker hands you. You commit to an outcome
**blind**, and 15 seconds later your bet fills at the **worse of two
Merkle-proven oracle prints** — the price at commit and the price at
commit+15s. Favourable movement in that window never improves your fill;
adverse movement degrades it slightly. **This kills latency arbitrage in both
directions:** nobody can snipe the house, and the house can't snipe you. Both
prices are verified on-chain via CPI into the [txoracle](https://txline.txodds.com)
program before a single dollar moves — the price is *proven*, not asserted.

*Design decision — the "commit + wait".* The 15-second delay is the anti-snipe
mechanism. But a feed is bursty: sometimes no fresh print lands in the window.
Rather than refund (bad UX) or trust a stale claim (unsafe), we **fall back to
the last proven price** — because if the market had actually moved, the oracle
would have printed a new one. You get worse-of-two protection when a fresh
price exists, and a guaranteed fill when it doesn't. Reliable *and*
snipe-resistant.

### 🏦 2. Anyone can be the house — passive, self-balancing liquidity
Post USDC, set your params, earn the margin on every bet — a bookmaker's edge,
but permissionless and fully collateralised. The magic is the **pricing loop**:
your quote is the oracle's fair price shaded by your *spread* and by **how
imbalanced your own book is**.

```
skew_bps(o) = skew_coeff_bps × (liability[o] − min(liability)) / max_risk_per_fixture
quote(o)    = fair(o) × (10000 − spread_bps − skew_bps(o)) / 10000   … clamped at odds_cap
```

The heavier your exposure on an outcome, the worse the price you show there —
which steers new flow to the other side and pulls your book back toward
balance **automatically, with no manual repricing.** A balanced book locks
almost nothing (collateral nets across outcomes); an imbalanced one pays for
its own risk. And you **can't go insolvent**: the invariant
`vault_balance ≥ total_locked` is enforced at every instruction boundary, so
every possible payout is pre-funded. Withdraw the free part anytime.

| Knob | Controls | Intuition |
|---|---|---|
| `spread_bps` | Your edge on every fill | Tighter wins more routed flow at thinner margin |
| `skew_coeff_bps` | How hard the book self-balances | Higher = rebalances faster, goes uncompetitive sooner; 0 = warehouse one-sided risk |
| `odds_cap` | Max payout multiple + collateral reserved per pending bet | Low = capital-efficient; high = quote long shots |
| `max_risk_per_fixture` | Worst-case loss on one game (and the skew denominator) | Smaller = more defensive |
| `max_total_risk` | Locked collateral across all games | Your overall book size |

### 🧭 3. Best-price routing — houses compete, bettors never choose
A bettor picks an outcome, not a counterparty. Every bet is routed to the
**best odds across every house that can collateralise it** — the protocol
simulates the commit against each house in best-price order and fills the first
that qualifies. Liquidity providers **bid against each other on price**, so
competition flows straight through to tighter odds for bettors. More houses =
better prices, permissionlessly.

### 🖥️ 4. Ship your own sportsbook on shared liquidity — via the SDK
The frontend is not the product; it's a *client*. `register_frontend(fee_bps)`
puts your storefront on-chain and **pays you a fee on every bet routed through
it.** Fork the UI, set your cut, point the `BthClient` SDK at the program, and
you're live on the same shared liquidity and the same proven oracle — no
license, no listing, no permission. The keeper that cranks fills and
settlements is permissionless too (anyone can run one and earn the reward).
**Distribution is open infrastructure.**

### 🎟️ 5. Honest UX — the amount you type is the amount charged
Fees and the keeper reward come *out of* your stake, not bolted on top — type
$500, spend exactly $500. Fills **can never fail economically** (payout ≤ the
collateral reserved at commit, by construction): no slippage rejection, no
partial fills. If the oracle is truly silent, your full stake auto-refunds —
the only async failure path, and it always favours you.

---

## How a bet works — four permissionless cranks

| Step | Instruction | What happens |
|---|---|---|
| **Commit** | `commit_bet` | Bettor picks fixture/outcome/stake. Worst-case collateral (`stake × odds_cap`) is reserved from the routed house *synchronously*; stake + fees + keeper rewards escrowed. |
| **Prove** | `prove_print` | Any keeper Merkle-verifies a StablePrice print (CPI → `validate_odds`) into a tiny shared `ProvenPrint` account. |
| **Fill** | `fill_bet` | Reads the commit-side and target-side proven prints, fills at the **worse of two** (or the last proven price on a lull), applies spread/skew, clamps at `odds_cap`. |
| **Settle** | `settle_bet` | Final score proven (CPI → `validate_stat_v2`) from the `game_finalised` event. Winners paid from the house vault. `refund_commit` / `void_bet` cover silence & abandoned games. |

All prices are **milliseconds**, odds ×1000, USDC 6dp, floor rounding — enforced
on-chain in `programs/bethehouse/src/math.rs` and mirrored 1:1 in
`packages/sdk/src/math.ts`, pinned by property tests against a surfpool
mainnet fork.

---

## 🗺️ Roadmap

- **💸 Cash out & trade your position.** Sell or offset an open bet *before*
  settlement as the odds move — take profit, cut losses, or flip your side. The
  house quotes a live buyback using the same oracle+skew engine, turning every
  bet into a tradable position. *(The single most-wanted feature.)*
- **🚀 Mainnet launch** with production TxODDS credentials.
- **📈 More markets:** Asian handicaps, over/under totals, both-teams-to-score,
  parlays — beyond straight 1X2.
- **🌍 More leagues & sports** across the full TxODDS coverage.
- **🤝 Pooled houses (LP shares):** many LPs deposit into one book and share
  P&L pro-rata via tokenized shares — scaling liquidity beyond single owners.

---

## ▶️ Run it

**Prerequisites:** Node 20+, pnpm, Rust + Anchor 0.32.1, Solana CLI, and a
TxODDS devnet API token/JWT. All config is documented in **`.env.example`**.

```bash
# 1. install
pnpm install

# 2. configure — see .env.example for every variable
cp .env.example .env                    # server keys: DEMO_PRIVATE_KEY, RPC_URL, TXLINE_DEV_*
cp .env.example packages/app/.env.local # client keys: NEXT_PUBLIC_RPC_URL, NEXT_PUBLIC_USDC_MINT

# 3. run the app (Next.js UI + API routes + keeper) against the live devnet book
cd packages/app && pnpm dev            # → http://localhost:3123
```

The keeper runs as a route (`/api/cron/keeper`) driven by **Vercel Cron** in
production (or any external cron / curl loop locally). Fund a wallet with test
USDC from the **+1000 USDC** faucet in the app, or
`POST /api/faucet {"to": "...", "amountUsdc": n}`.

### Deploy your own instance

```bash
anchor build
solana program deploy target/deploy/bethehouse.so \
  --program-id target/deploy/bethehouse-keypair.json -u devnet
DEVNET_USDC=<your-mint> npx tsx scripts/deploy-devnet.ts   # config + frontend + houses
```

### Test

```bash
pnpm test        # vitest: every instruction against surfpool mainnet forks, real captured proofs
cargo test       # pure pricing/collateral math
```

---

## Repo layout

```
programs/bethehouse   Anchor program — the protocol (state, math, oracle CPI, instructions)
packages/txline       TxODDS API client (auth, odds/scores, Merkle proofs)
packages/sdk          BthClient, PDAs, proof mappers, reference math, permissionless keeper
packages/app          Next.js frontend + same-origin API routes + keeper cron (Vercel-ready)
tests/                vitest suites vs surfpool mainnet forks · fixtures/ captured real proofs
scripts/              deploy-devnet · capture-fixtures · live-e2e · demo
```

Built with Anchor · @solana/kit · Next.js · TxODDS StablePrice. Every fill and
settlement is auditable on-chain against the oracle — **a book you can verify,
not one you have to trust.**
