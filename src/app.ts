import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb, type Db } from "./db.js";
import { seed } from "./seed.js";
import {
  BookingError, exportIcal, getBooking, handlePaymentWebhook, placeHold, search, signPayload,
} from "./service.js";

// Demo-only secret. A real deployment would load it from the environment and the
// *payment provider* would sign the events, not this server.
export const DEMO_SECRET = "whsec_demo_only";

const here = dirname(fileURLToPath(import.meta.url));

async function fresh(): Promise<Db> {
  const db = await createDb();
  await seed(db);
  return db;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new BookingError("invalid", "request too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function createApp() {
  let db = await fresh();

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, await readFile(join(here, "..", "public", "index.html"), "utf8"), "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/api/search") {
        const p = url.searchParams;
        const amenities = (p.get("amenities") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const rooms = await search(db, {
          checkIn: p.get("checkIn") ?? "", checkOut: p.get("checkOut") ?? "",
          guests: Number(p.get("guests") || 1),
          maxNightlyCents: p.get("maxPrice") ? Math.round(Number(p.get("maxPrice")) * 100) : undefined,
          amenities, city: p.get("city") || undefined,
        });
        return send(res, 200, { rooms });
      }

      if (req.method === "POST" && url.pathname === "/api/hold") {
        const b = JSON.parse(await readBody(req));
        const h = await placeHold(db, {
          roomId: Number(b.roomId), guestEmail: String(b.guestEmail ?? ""), guests: Number(b.guests || 1),
          checkIn: String(b.checkIn ?? ""), checkOut: String(b.checkOut ?? ""),
        });
        return send(res, 201, h);
      }

      // Demo stand-in for the payment provider: signs an event and delivers it to the
      // real webhook handler. Calling it twice for one booking sends the SAME event id,
      // so the second delivery comes back "duplicate".
      if (req.method === "POST" && url.pathname === "/api/demo/pay") {
        const { bookingId } = JSON.parse(await readBody(req));
        const booking = await getBooking(db, Number(bookingId));
        if (!booking) return send(res, 404, { error: "no such booking" });
        const body = JSON.stringify({
          id: `evt_demo_${booking.id}`, type: "payment.succeeded",
          data: { booking_id: booking.id, amount_cents: booking.total_cents },
        });
        const result = await handlePaymentWebhook(db, body, signPayload(body, DEMO_SECRET), DEMO_SECRET);
        return send(res, 200, { result, booking: await getBooking(db, booking.id) });
      }

      if (req.method === "POST" && url.pathname === "/api/demo/bad-webhook") {
        const body = JSON.stringify({ id: "evt_forged", type: "payment.succeeded", data: { booking_id: 1, amount_cents: 1 } });
        const result = await handlePaymentWebhook(db, body, "t=1,v1=" + "0".repeat(64), DEMO_SECRET);
        return send(res, 200, { result });
      }

      const stays = /^\/api\/rooms\/(\d+)\/stays$/.exec(url.pathname);
      if (req.method === "GET" && stays) {
        const r = await db.query(
          `select id, lower(during)::text check_in, upper(during)::text check_out, status, source
             from bookings where room_id = $1 and status in ('held','confirmed') order by lower(during)`, [Number(stays[1])]);
        return send(res, 200, { stays: r.rows });
      }

      const ics = /^\/api\/rooms\/(\d+)\.ics$/.exec(url.pathname);
      if (req.method === "GET" && ics) {
        return send(res, 200, await exportIcal(db, Number(ics[1])), "text/calendar; charset=utf-8");
      }

      if (req.method === "POST" && url.pathname === "/api/demo/reset") {
        db = await fresh();
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof BookingError) return send(res, e.code === "unavailable" ? 409 : e.code === "not_found" ? 404 : 400, { error: e.message, code: e.code });
      if (e instanceof SyntaxError || (e instanceof Error && /bad date|after check-in/.test(e.message))) return send(res, 400, { error: (e as Error).message, code: "invalid" });
      console.error(e);
      return send(res, 500, { error: "internal error" });
    }
  };

  return handler;
}

export async function listen(port: number): Promise<Server> {
  const server = createServer(await createApp());
  await new Promise<void>((r) => server.listen(port, r));
  return server;
}
