// Proof relay for third-party keepers.
import { NextRequest, NextResponse } from "next/server";
import { txline } from "../../../../lib/server";

export async function GET(req: NextRequest) {
  const fixtureId = req.nextUrl.searchParams.get("fixtureId");
  const seq = req.nextUrl.searchParams.get("seq");
  const statKeys = (req.nextUrl.searchParams.get("statKeys") ?? "1,2").split(",").map(Number);
  if (!fixtureId || !seq) {
    return NextResponse.json({ error: "fixtureId and seq required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await txline().statValidation(Number(fixtureId), Number(seq), statKeys));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
