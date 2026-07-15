// Verifiable-resolution data for the receipt: final score, the txoracle
// daily scores-root account the result verifies against, and the seq.
import { NextRequest, NextResponse } from "next/server";
import { TxLineClient } from "@bethehouse/txline";
import { scoresRootPda } from "@bethehouse/sdk";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ fixtureId: string }> },
) {
  const { fixtureId } = await params;
  try {
    const txline = TxLineClient.fromEnv();
    const events = await txline.scoresSnapshot(Number(fixtureId));
    const finalised = events.find((e) => e.Action === "game_finalised");
    if (!finalised) return NextResponse.json({ error: "not finished" }, { status: 404 });
    const s1 = finalised.Stats?.["1"] ?? 0;
    const s2 = finalised.Stats?.["2"] ?? 0;
    // the root account the settle proof verified against
    const proof = await txline.statValidation(Number(fixtureId), finalised.Seq, [1, 2]);
    const root = scoresRootPda(proof.summary.updateStats.minTimestamp);
    return NextResponse.json({
      fixtureId: Number(fixtureId),
      score: [s1, s2],
      seq: finalised.Seq,
      scoresRoot: root.toBase58(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
