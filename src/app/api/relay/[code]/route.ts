// Fallback transport for players whose NAT/firewall blocks WebRTC peer-to-peer.
// Packets are POSTed here and fanned out to the other player over Server-Sent Events.
// (In-memory mailbox: fine for a single Node process; P2P remains the fast path.)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Sub = { send: (s: string) => void; close: () => void };
interface Room {
  subs: (Sub | null)[];
  backlog: string[][];
  at: number;
}
const g = globalThis as typeof globalThis & { __kaijuRelay?: Map<string, Room> };
const relay = g.__kaijuRelay ?? (g.__kaijuRelay = new Map<string, Room>());

type Ctx = { params: Promise<{ code: string }> };
const valid = (c: string) => /^[A-Z0-9]{5}$/.test(c);

function room(code: string): Room {
  const now = Date.now();
  if (relay.size > 200) for (const [k, r] of relay) if (now - r.at > 2 * 3600 * 1000) relay.delete(k);
  let r = relay.get(code);
  if (!r) {
    r = { subs: [null, null], backlog: [[], []], at: now };
    relay.set(code, r);
  }
  r.at = now;
  return r;
}

export async function GET(req: Request, ctx: Ctx) {
  const code = (await ctx.params).code.toUpperCase();
  if (!valid(code)) return new Response("bad room", { status: 400 });
  const role = new URL(req.url).searchParams.get("role") === "1" ? 1 : 0;
  const r = room(code);
  const enc = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const sub: Sub = {
        send: (s) => {
          try {
            c.enqueue(enc.encode(`data: ${s}\n\n`));
          } catch {}
        },
        close: () => {
          try {
            c.close();
          } catch {}
        },
      };
      r.subs[role]?.close();
      r.subs[role] = sub;
      c.enqueue(enc.encode(": ok\n\n"));
      for (const m of r.backlog[role]) sub.send(m);
      r.backlog[role] = [];
      ping = setInterval(() => sub.send(""), 15000);
      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        if (r.subs[role] === sub) r.subs[role] = null;
        sub.close();
      });
    },
    cancel() {
      clearInterval(ping);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}

export async function POST(req: Request, ctx: Ctx) {
  const code = (await ctx.params).code.toUpperCase();
  if (!valid(code)) return new Response("bad room", { status: 400 });
  const q = new URL(req.url).searchParams;
  const role = q.get("role") === "1" ? 1 : 0, ch = q.get("ch") === "c" ? "c" : "i";
  const body = await req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > 4096) return new Response(null, { status: 413 });
  const msg = ch + Buffer.from(body).toString("base64");
  const r = room(code);
  const dst = r.subs[1 - role];
  if (dst) dst.send(msg);
  else if (ch === "c" && r.backlog[1 - role].length < 32) r.backlog[1 - role].push(msg); // control messages wait for the peer
  return new Response(null, { status: 204 });
}
