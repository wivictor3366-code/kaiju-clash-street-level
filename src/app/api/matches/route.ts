import { db } from "@/db";
import { matches } from "@/db/schema";
import { desc, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const recent = await db.select().from(matches).orderBy(desc(matches.id)).limit(8);
  const [tot] = await db.select({ n: sql<number>`count(*)::int`, havoc: sql<number>`coalesce(sum(${matches.havoc}), 0)::int` }).from(matches);
  return NextResponse.json({ recent, total: tot?.n ?? 0, havoc: tot?.havoc ?? 0 }, { headers: { "cache-control": "no-store" } });
}

const clean = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase().replace(/[^A-Z0-9 .!-]/g, "").slice(0, 24) || fallback : fallback);
const int = (v: unknown, lo: number, hi: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : lo;
  return Math.max(lo, Math.min(hi, n));
};

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const mode = b.mode === "online" || b.mode === "local" || b.mode === "cpu" ? b.mode : null;
  if (!mode) return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  await db.insert(matches).values({
    mode,
    p1: clean(b.p1, "PLAYER 1"),
    p2: clean(b.p2, "PLAYER 2"),
    c1: int(b.c1, 0, 1),
    c2: int(b.c2, 0, 1),
    winner: int(b.winner, 1, 3),
    havoc: int(b.havoc, 0, 10_000_000),
    frames: int(b.frames, 0, 10_000_000),
  });
  return NextResponse.json({ ok: true });
}
