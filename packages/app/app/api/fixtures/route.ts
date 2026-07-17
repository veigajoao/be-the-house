import { NextResponse } from "next/server";
import { getFixtures } from "../../../lib/market";

export async function GET() {
  try {
    return NextResponse.json(await getFixtures());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
