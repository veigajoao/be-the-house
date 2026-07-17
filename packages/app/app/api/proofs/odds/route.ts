// Proof relay for third-party keepers.
import { NextRequest, NextResponse } from "next/server";
import { txline } from "../../../../lib/server";

export async function GET(req: NextRequest) {
  const messageId = req.nextUrl.searchParams.get("messageId");
  const ts = req.nextUrl.searchParams.get("ts");
  if (!messageId || !ts) {
    return NextResponse.json({ error: "messageId and ts required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await txline().oddsValidation(messageId, Number(ts)));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
