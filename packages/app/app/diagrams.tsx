// Hand-drawn SVG diagrams for the landing page, in the paper-coupon aesthetic.
// Colours come from the CSS vars (--ink / --stamp / --gold / --green / --rule).
import type { ReactNode } from "react";

const INK = "var(--ink)";
const RULE = "var(--rule)";
const STAMP = "var(--stamp)";
const GOLD = "var(--gold)";
const GREEN = "var(--green)";
const CARD = "var(--card)";

function Frame({ children, cap }: { children: ReactNode; cap: string }) {
  return (
    <div className="diagram">
      {children}
      <div className="cap">{cap}</div>
    </div>
  );
}

/** step box with a condensed title + up to two mono sublines */
function Box({
  x,
  y,
  w,
  h,
  title,
  sub,
  accent,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string[];
  accent?: string;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill={CARD} stroke={accent ?? INK} strokeWidth={1.5} />
      <text x={x + w / 2} y={y + 22} textAnchor="middle" className="svg-cond" fill={accent ?? INK}>
        {title}
      </text>
      {sub?.map((s, i) => (
        <text key={i} x={x + w / 2} y={y + 40 + i * 13} textAnchor="middle" className="svg-mono-sm">
          {s}
        </text>
      ))}
    </g>
  );
}

function Arrow({ x1, x2, y }: { x1: number; x2: number; y: number }) {
  return (
    <g stroke={INK} strokeWidth={1.5} fill={INK}>
      <line x1={x1} y1={y} x2={x2 - 7} y2={y} />
      <polygon points={`${x2},${y} ${x2 - 8},${y - 4} ${x2 - 8},${y + 4}`} stroke="none" />
    </g>
  );
}

// ---------------- 1. bet lifecycle ----------------
export function BetDiagram() {
  const boxes = [
    { t: "Commit", s: ["you pick outcome", "+ stake (blind)"] },
    { t: "Lock", s: ["worse of now", "& +15s price"] },
    { t: "Fill", s: ["keeper proves,", "bet goes Active"] },
    { t: "Result", s: ["final score", "proven on-chain"] },
    { t: "Paid", s: ["won pays out /", "lost stays w/ house"] },
  ];
  const W = 168;
  const GAP = 30;
  const step = W + GAP;
  const y = 74;
  const H = 78;
  const axis = ["t = 0", "+15 s", "next print", "full-time", "settled"];

  return (
    <Frame cap="A bet's life: commit blind → fill at the worse-of-two proven prices → settle on the proven score.">
      <svg viewBox="0 0 990 210" role="img" aria-label="Bet lifecycle: commit, lock, fill, result, paid">
        {/* top axis */}
        <line x1={10} y1={40} x2={980} y2={40} stroke={RULE} strokeWidth={1} />
        {boxes.map((_, i) => {
          const cx = 5 + i * step + W / 2;
          return (
            <g key={i}>
              <line x1={cx} y1={36} x2={cx} y2={44} stroke={RULE} />
              <text x={cx} y={30} textAnchor="middle" className="svg-mono-sm">
                {axis[i]}
              </text>
            </g>
          );
        })}
        {/* boxes + arrows */}
        {boxes.map((b, i) => {
          const x = 5 + i * step;
          const accent = i === 1 || i === 2 ? STAMP : i === 4 ? GREEN : INK;
          return (
            <g key={i}>
              <Box x={x} y={y} w={W} h={H} title={b.t} sub={b.s} accent={accent} />
              {i < boxes.length - 1 && <Arrow x1={x + W} x2={x + step} y={y + H / 2} />}
            </g>
          );
        })}
        {/* trustless bracket under Lock+Fill */}
        <line x1={5 + step} y1={168} x2={5 + 2 * step + W} y2={168} stroke={STAMP} strokeWidth={1} />
        <line x1={5 + step} y1={164} x2={5 + step} y2={168} stroke={STAMP} />
        <line x1={5 + 2 * step + W} y1={164} x2={5 + 2 * step + W} y2={168} stroke={STAMP} />
        <text
          x={5 + 1.5 * step + W / 2}
          y={186}
          textAnchor="middle"
          className="svg-mono-sm"
          fill={STAMP}
        >
          both prices Merkle-proven vs TxODDS roots — no trusted party
        </text>
      </svg>
    </Frame>
  );
}

// ---------------- 2. pricing pipeline ----------------
export function PricingDiagram() {
  return (
    <Frame cap="Your quote = the oracle's fair price, shaded by your spread and your book's imbalance, capped.">
      <svg viewBox="0 0 990 180" role="img" aria-label="Pricing pipeline">
        <Box x={5} y={54} w={170} h={70} title="Oracle" sub={["TxODDS StablePrice", "fair odds (proven)"]} accent={GREEN} />
        <Arrow x1={175} x2={215} y={89} />
        <Box x={215} y={54} w={150} h={70} title="− spread" sub={["your edge", "on every fill"]} />
        <Arrow x1={365} x2={405} y={89} />
        <Box x={405} y={54} w={170} h={70} title="− skew" sub={["grows with your", "book imbalance"]} accent={GOLD} />
        <Arrow x1={575} x2={615} y={89} />
        <Box x={615} y={54} w={150} h={70} title="clamp cap" sub={["≤ odds_cap"]} />
        <Arrow x1={765} x2={805} y={89} />
        <Box x={805} y={54} w={180} h={70} title="Your quote" sub={["shown to bettors", "best-price wins"]} accent={STAMP} />
        {/* formula strip */}
        <text x={495} y={150} textAnchor="middle" className="svg-mono" fill="var(--ink-2)">
          quote(o) = fair(o) × (10000 − spread − skew(o)) / 10000 , capped at odds_cap
        </text>
      </svg>
    </Frame>
  );
}

// ---------------- 3. book / skew / netting ----------------
export function BookDiagram() {
  // liability bars for one fixture: Home heavy, Draw light, Away mid
  const bars = [
    { lab: "1 HOME", v: 100, max: true },
    { lab: "X DRAW", v: 18 },
    { lab: "2 AWAY", v: 62 },
  ];
  const baseX = 150;
  const fullW = 360;
  const y0 = 40;
  return (
    <Frame cap="Locked = max(liability) − stakes collected. A balanced book locks ≈ 0; skew steers flow toward balance.">
      <svg viewBox="0 0 990 210" role="img" aria-label="Book exposure and skew">
        {bars.map((b, i) => {
          const y = y0 + i * 46;
          const w = (b.v / 100) * fullW;
          return (
            <g key={i}>
              <text x={baseX - 12} y={y + 17} textAnchor="end" className="svg-mono">
                {b.lab}
              </text>
              <rect x={baseX} y={y} width={fullW} height={24} fill="none" stroke={RULE} />
              <rect x={baseX} y={y} width={w} height={24} fill={b.max ? STAMP : "var(--ink-3)"} />
              {b.max && (
                <text x={baseX + w + 10} y={y + 17} className="svg-mono-sm" fill={STAMP}>
                  ← heaviest side: skew widens here, worsening its price
                </text>
              )}
            </g>
          );
        })}
        {/* netting line */}
        <text x={baseX} y={188} className="svg-mono" fill="var(--ink-2)">
          worst-case exposure = max(liabilities) − stakes collected  →  your locked collateral
        </text>
        {/* routing arrow */}
        <text x={baseX + fullW + 60} y={y0 + 66} textAnchor="middle" className="svg-cond" fill={GREEN}>
          flow
        </text>
        <Arrow x1={baseX + fullW + 30} x2={baseX + fullW + 92} y={y0 + 80} />
        <text x={baseX + fullW + 60} y={y0 + 98} textAnchor="middle" className="svg-mono-sm">
          steered to the
        </text>
        <text x={baseX + fullW + 60} y={y0 + 110} textAnchor="middle" className="svg-mono-sm">
          light side
        </text>
      </svg>
    </Frame>
  );
}
