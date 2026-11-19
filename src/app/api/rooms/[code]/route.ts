import { db } from "@/db";
import { rooms } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { code } = await ctx.params;
  const rows = await db.select().from(rooms).where(eq(rooms.code, code.toUpperCase())).limit(1);
  if (!rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ offer: rows[0].offer, answer: rows[0].answer }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, ctx: Ctx) {
  const { code } = await ctx.params;
  let body: { answer?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const answer = body.answer;
  if (typeof answer !== "string" || answer.length < 20 || answer.length > 20000) return NextResponse.json({ error: "invalid answer" }, { status: 400 });
  // first challenger wins the seat
  const res = await db
    .update(rooms)
    .set({ answer })
    .where(and(eq(rooms.code, code.toUpperCase()), isNull(rooms.answer)))
    .returning({ code: rooms.code });
  if (!res.length) return NextResponse.json({ error: "room full or missing" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
