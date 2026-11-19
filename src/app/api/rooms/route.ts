import { db } from "@/db";
import { rooms } from "@/db/schema";
import { lt } from "drizzle-orm";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export async function POST(req: Request) {
  let body: { offer?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const offer = body.offer;
  if (typeof offer !== "string" || offer.length < 20 || offer.length > 20000) return NextResponse.json({ error: "invalid offer" }, { status: 400 });
  // expire stale rooms
  await db.delete(rooms).where(lt(rooms.createdAt, new Date(Date.now() - 30 * 60 * 1000)));
  for (let attempt = 0; attempt < 6; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    const res = await db.insert(rooms).values({ code, offer }).onConflictDoNothing().returning({ code: rooms.code });
    if (res.length) return NextResponse.json({ code });
  }
  return NextResponse.json({ error: "could not allocate room" }, { status: 503 });
}
