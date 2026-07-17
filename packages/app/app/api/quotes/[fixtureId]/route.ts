import { NextRequest, NextResponse } from "next/server";
import { getQuotes } from "../../../../lib/market";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ fixtureId: string }> },
) {
  const { fixtureId } = await params;
  try {
    const q = await getQuotes(Number(fixtureId));
    if (!q) return NextResponse.json({ error: "no live 1X2 StablePrice print" }, { status: 404 });
    return NextResponse.json(q);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
