// Landing page (server component). Slim sticky header, hero, a live devnet
// strip, and layered docs with hand-drawn SVG diagrams. The wallet stack is
// NOT loaded here — it's scoped to the /app subtree.
import Link from "next/link";
import idl from "../lib/idl/bethehouse.json";
import { getFixtures } from "../lib/market";
import { BetDiagram, PricingDiagram, BookDiagram } from "./diagrams";

export const dynamic = "force-dynamic";

const PROGRAM_ID = (idl as { address: string }).address;
const EXPLORER = `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`;

async function liveMarkets() {
  try {
    const fx = await getFixtures();
    return fx
      .filter((f) => f.StartTime > Date.now() - 3 * 3600_000)
      .sort((a, b) => a.StartTime - b.StartTime)
      .slice(0, 3);
  } catch {
    return [];
  }
}

export default async function Landing() {
  const markets = await liveMarkets();

  return (
    <div className="landing">
      <header className="lhead">
        <Link href="/" className="logo" style={{ textDecoration: "none", color: "inherit" }}>
          BeThe<span>House</span>
        </Link>
        <nav>
          <a href="#how">How it works</a>
          <a href="#house">Be the house</a>
          <Link href="/app" className="cta solid">
            Go to app →
          </Link>
        </nav>
      </header>

      {/* ---------- hero ---------- */}
      <section className="hero">
        <h1>
          Anyone can <span>be the house.</span>
        </h1>
        <p className="sub">
          A permissionless on-chain sportsbook on Solana. Post USDC liquidity with your own spread
          and risk limits, or bet against houses that already have. Prices come from the TxODDS
          oracle; every fill and settlement is verified on-chain with Merkle proofs — no trusted
          bookmaker anywhere in the loop.
        </p>
        <div className="hero-cta">
          <Link href="/app" className="cta solid">
            Go to app
          </Link>
          <a href="#how" className="cta ghost">
            How it works ↓
          </a>
        </div>

        <div className="live">
          <span className="live-lab">
            <span className="live-dot" /> Live on devnet
          </span>
          <a href={EXPLORER} target="_blank" rel="noreferrer">
            program {PROGRAM_ID.slice(0, 6)}…{PROGRAM_ID.slice(-4)} ↗
          </a>
          {markets.map((m) => (
            <div className="mkt" key={m.FixtureId}>
              {m.Participant1} — {m.Participant2}
              <small>
                {m.Competition} · {new Date(m.StartTime).toUTCString().slice(5, 17)} UTC
              </small>
            </div>
          ))}
          {markets.length === 0 && (
            <div className="mkt">
              markets open as kickoffs are published<small>from the live TxLINE feed</small>
            </div>
          )}
        </div>
      </section>

      {/* ---------- 1. how betting works ---------- */}
      <section className="doc" id="how">
        <div className="doc-num">01 — FOR BETTORS</div>
        <h2>How a bet works</h2>
        <p className="lead">
          You pick an outcome and a stake. That&apos;s it — no bookmaker sets your line, no order
          book, no counterparty risk. You commit <b>blind</b> to the oracle price, and the protocol
          guarantees your bet fills.
        </p>

        <BetDiagram />

        <div className="deep">
          <h3>The odds you see are a ceiling, not a price</h3>
          <p>
            When you tap an outcome, the odds shown are the <b>best you can get</b>. Your bet fills
            at the <b>worse of two prices</b>: the oracle price at the moment you commit, and the
            price 15 seconds later — <code>min(price@commit, price@commit+15s)</code>. Favourable
            movement in that window never improves your fill; adverse movement degrades it slightly.
            This removes latency arbitrage in both directions: nobody can snipe the house, and the
            house can&apos;t snipe you.
          </p>
        </div>

        <div className="deep">
          <h3>Where the price comes from — and why you can trust it</h3>
          <p>
            Prices are the <b>TxODDS StablePrice</b> feed: a demargined consensus of sharp
            bookmakers. Every price update is committed to a Merkle root published on-chain by the{" "}
            <code>txoracle</code> program. To fill your bet, a keeper doesn&apos;t just <i>claim</i>{" "}
            a price — it submits the two price records with their Merkle proofs, and our program
            verifies them on-chain (via CPI into txoracle) before a single dollar moves. The price
            is cryptographically proven, not asserted.
          </p>
        </div>

        <div className="deep">
          <h3>Fills are guaranteed; the keeper is permissionless</h3>
          <p>
            At commit, the house reserves worst-case collateral (<code>stake × odds_cap</code>), so
            a fill can never fail for lack of funds — no slippage rejection, no partial fills. The
            fill itself is cranked by a <b>permissionless keeper</b> (anyone can run one): it proves
            the two prints, computes worse-of-two, and finalises the bet on-chain. If the oracle
            genuinely goes silent and no valid price exists, your full stake is automatically
            refunded — the only asynchronous failure path, and it always favours you.
          </p>
        </div>

        <div className="deep">
          <h3>Settlement is proven too</h3>
          <p>
            When the match finishes, settlement is verified the same way: the final score is proven
            against the TxODDS scores Merkle root, and only a score from the{" "}
            <code>game_finalised</code> event counts. Win → the house vault pays you; lose → your
            stake stays with the house. The result is verifiable on-chain against the oracle — this
            is a book you can audit, not one you have to trust.
          </p>
        </div>
      </section>

      {/* ---------- 2. be the house ---------- */}
      <section className="doc" id="house">
        <div className="doc-num">02 — FOR LIQUIDITY PROVIDERS</div>
        <h2>How to be the house</h2>
        <p className="lead">
          A house is a liquidity pool you own. You deposit USDC and publish your own quoting policy;
          the protocol routes bets to whichever house offers the best price and can cover them. You
          earn the <b>spread</b> on every fill — a bookmaker&apos;s margin, but permissionless and
          fully collateralised.
        </p>

        <PricingDiagram />

        <p>
          The oracle sets the fair price; your quote is that price shaded by your spread and by how{" "}
          <b>imbalanced your book is</b>. The more one-sided your exposure on an outcome, the worse
          the price you show on that side — which steers new flow to the other side and pulls your
          book back toward balance.
        </p>

        <BookDiagram />

        <div className="deep">
          <h3>The parameters you tune</h3>
          <table className="ptable">
            <thead>
              <tr>
                <th>Parameter</th>
                <th>What it controls</th>
                <th>Tuning intuition</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>spread_bps</td>
                <td>Your edge over the oracle price on every fill.</td>
                <td>Tighter wins more routed flow at thinner margin — you bid against every other house.</td>
              </tr>
              <tr>
                <td>skew_coeff_bps</td>
                <td>How hard the quote reacts to book imbalance.</td>
                <td>Higher = self-balances faster but goes uncompetitive sooner; 0 = warehouse one-sided risk.</td>
              </tr>
              <tr>
                <td>odds_cap</td>
                <td>Max payout multiple; also the collateral reserved per pending bet (<b>stake × cap</b>).</td>
                <td>High cap quotes long shots but ties up capital until fill; low cap is capital-efficient.</td>
              </tr>
              <tr>
                <td>max_risk_per_fixture</td>
                <td>Worst-case net loss cap on one game; the skew denominator.</td>
                <td>Smaller = the same imbalance produces more skew (more defensive).</td>
              </tr>
              <tr>
                <td>max_total_risk</td>
                <td>Ceiling on locked collateral across all fixtures.</td>
                <td>Your overall book size relative to the vault.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="deep">
          <h3>Choose which markets you offer</h3>
          <p>
            Publish an <b>offer policy</b> on-chain: quote <i>only</i> selected competitions or
            matches, or <i>everything except</i> a few. The match rule is enforced at commit — a bet
            naming a fixture you excluded is rejected by the program itself; the competition rule is
            applied by routing. Set it when you create your house, or change it anytime.
          </p>
        </div>

        <div className="deep">
          <h3>You cannot go insolvent</h3>
          <p>
            The <b>vault invariant</b> holds at every instruction boundary:{" "}
            <code>vault_balance ≥ total_locked</code>. Every possible payout is pre-funded, and
            liabilities net across outcomes — a balanced book locks almost nothing, so your capital
            stays free. You withdraw the unlocked portion whenever you like; no one else can touch
            your vault.
          </p>
        </div>

        <div className="hero-cta" style={{ marginTop: 32 }}>
          <Link href="/app" className="cta solid">
            Open the app
          </Link>
          <Link href="/app" className="cta ghost">
            Create a house
          </Link>
        </div>
      </section>

      <footer className="lfoot">
        <span>BeTheHouse · permissionless on-chain sportsbook · Solana devnet · TxODDS feed</span>
        <span>
          <a href={EXPLORER} target="_blank" rel="noreferrer">
            program on explorer ↗
          </a>
        </span>
      </footer>
    </div>
  );
}
