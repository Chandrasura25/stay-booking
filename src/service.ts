import { createHmac, timingSafeEqual } from "node:crypto";
import { type Db, isOverlap } from "./db.js";
import { nights } from "./dates.js";

export const HOLD_MINUTES = 15;

export class BookingError extends Error {
  constructor(public code: "unavailable" | "invalid" | "not_found", msg: string) { super(msg); }
}

// ---------- search -------------------------------------------------------

export interface SearchInput {
  checkIn: string; checkOut: string; guests?: number;
  maxNightlyCents?: number; amenities?: string[]; city?: string;
}

export async function search(db: Db, q: SearchInput, now = new Date()) {
  const n = nights(q.checkIn, q.checkOut);
  await sweepExpiredHolds(db, now);
  const r = await db.query<{ room_id: number; room: string; property: string; city: string; nightly_cents: number; capacity: number; amenities: string[] }>(
    `select r.id room_id, r.name room, p.name property, p.city, r.nightly_cents, r.capacity, r.amenities
       from rooms r join properties p on p.id = r.property_id
      where r.capacity >= $1
        and ($2::int is null or r.nightly_cents <= $2)
        and r.amenities @> $3::text[]
        and ($4::text is null or lower(p.city) = lower($4))
        and not exists (
          select 1 from bookings b
           where b.room_id = r.id and b.status in ('held','confirmed')
             and b.during && daterange($5::date, $6::date, '[)'))
      order by r.nightly_cents, r.id`,
    [q.guests ?? 1, q.maxNightlyCents ?? null, q.amenities ?? [], q.city ?? null, q.checkIn, q.checkOut],
  );
  return r.rows.map((x) => ({ ...x, nights: n, totalCents: x.nightly_cents * n }));
}

// ---------- holds & booking ----------------------------------------------

/** Cancels holds whose payment window passed, freeing the dates. */
export async function sweepExpiredHolds(db: Db, now = new Date()) {
  const r = await db.query(
    `update bookings set status = 'cancelled'
      where status = 'held' and hold_expires_at <= $1 returning id`, [now.toISOString()]);
  return r.rows.length;
}

export interface HoldInput { roomId: number; guestEmail: string; guests: number; checkIn: string; checkOut: string }

export async function placeHold(db: Db, i: HoldInput, now = new Date()) {
  const n = nights(i.checkIn, i.checkOut);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.guestEmail)) throw new BookingError("invalid", "invalid email");
  await sweepExpiredHolds(db, now);
  const room = (await db.query<{ capacity: number; nightly_cents: number }>(
    `select capacity, nightly_cents from rooms where id = $1`, [i.roomId])).rows[0];
  if (!room) throw new BookingError("not_found", "no such room");
  if (i.guests < 1 || i.guests > room.capacity) throw new BookingError("invalid", `room sleeps ${room.capacity}`);
  const expires = new Date(now.getTime() + HOLD_MINUTES * 60_000).toISOString();
  try {
    const r = await db.query<{ id: number }>(
      `insert into bookings (room_id, guest_email, guests, during, status, hold_expires_at, total_cents)
       values ($1,$2,$3,daterange($4::date,$5::date,'[)'),'held',$6,$7) returning id`,
      [i.roomId, i.guestEmail, i.guests, i.checkIn, i.checkOut, expires, room.nightly_cents * n]);
    return { bookingId: r.rows[0].id, totalCents: room.nightly_cents * n, holdExpiresAt: expires };
  } catch (e) {
    // The database decided. We only translate its answer.
    if (isOverlap(e)) throw new BookingError("unavailable", "those dates are no longer available");
    throw e;
  }
}

export async function getBooking(db: Db, id: number) {
  const r = await db.query<{ id: number; status: string; total_cents: number; check_in: string; check_out: string; source: string }>(
    `select id, status, total_cents, lower(during)::text check_in, upper(during)::text check_out, source
       from bookings where id = $1`, [id]);
  return r.rows[0];
}

// ---------- payment webhooks ---------------------------------------------

export function signPayload(body: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export function verifySignature(body: string, header: string | undefined, secret: string, now = Date.now(), toleranceSec = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > toleranceSec) return false; // replay window
  const want = createHmac("sha256", secret).update(`${m[1]}.${body}`).digest();
  const got = Buffer.from(m[2], "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export type WebhookResult =
  | { status: "confirmed" | "duplicate" | "needs_refund" | "amount_mismatch" | "ignored" }
  | { status: "rejected"; reason: string };

/**
 * payment.succeeded -> confirm the held booking. Safe to deliver twice: the
 * event id is recorded in the same transaction, so a retry changes nothing.
 */
export async function handlePaymentWebhook(
  db: Db, body: string, header: string | undefined, secret: string, now = new Date(),
): Promise<WebhookResult> {
  if (!verifySignature(body, header, secret, now.getTime())) return { status: "rejected", reason: "bad signature" };
  let ev: { id: string; type: string; data: { booking_id: number; amount_cents: number } };
  try { ev = JSON.parse(body); } catch { return { status: "rejected", reason: "bad json" }; }
  if (ev.type !== "payment.succeeded") return { status: "ignored" };

  return db.transaction(async (tx) => {
    const seen = await tx.query(
      `insert into payment_events (event_id, booking_id, outcome) values ($1,$2,'processing')
       on conflict (event_id) do nothing returning event_id`, [ev.id, ev.data.booking_id]);
    if (seen.rows.length === 0) return { status: "duplicate" as const };

    await tx.query(`update bookings set status = 'cancelled' where status = 'held' and hold_expires_at <= $1`, [now.toISOString()]);
    const b = (await tx.query<{ status: string; total_cents: number }>(
      `select status, total_cents from bookings where id = $1 for update`, [ev.data.booking_id])).rows[0];
    let status: "confirmed" | "needs_refund" | "amount_mismatch" = "confirmed";
    if (!b) status = "needs_refund";
    else if (b.total_cents !== ev.data.amount_cents) status = "amount_mismatch";
    else if (b.status === "held") {
      await tx.query(`update bookings set status = 'confirmed', hold_expires_at = null where id = $1`, [ev.data.booking_id]);
    } else if (b.status === "cancelled") status = "needs_refund"; // paid after the hold lapsed: flag it, never silently re-book
    await tx.query(`update payment_events set outcome = $2 where event_id = $1`, [ev.id, status]);
    return { status };
  });
}

// ---------- iCal ---------------------------------------------------------

const ical = (d: string) => d.replaceAll("-", "");

/** Feed other calendars (Airbnb, Google...) can subscribe to. No guest details leave the system. */
export async function exportIcal(db: Db, roomId: number) {
  const r = await db.query<{ id: number; ci: string; co: string }>(
    `select id, lower(during)::text ci, upper(during)::text co from bookings
      where room_id = $1 and status in ('held','confirmed') order by lower(during)`, [roomId]);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//stay-booking//EN", "CALSCALE:GREGORIAN"];
  for (const b of r.rows) {
    lines.push("BEGIN:VEVENT", `UID:booking-${b.id}@stay-booking`, `DTSTART;VALUE=DATE:${ical(b.ci)}`,
      `DTEND;VALUE=DATE:${ical(b.co)}`, "SUMMARY:Reserved", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function parseIcal(text: string) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events: { uid: string; start: string; end: string }[] = [];
  const fmt = (v?: string) => (v && /^\d{8}/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : undefined);
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const get = (k: string) => new RegExp(`^${k}[^:\\r\\n]*:(.+)$`, "m").exec(body)?.[1].trim();
    const uid = get("UID"), start = fmt(get("DTSTART")), end = fmt(get("DTEND"));
    if (uid && start && end) events.push({ uid, start, end });
  }
  return events;
}

/**
 * Pull another calendar's blocks in. Re-importing the same feed changes nothing
 * (keyed by UID), and a block that collides with a real booking is reported,
 * not forced in.
 */
export async function importIcal(db: Db, roomId: number, text: string) {
  const out = { imported: 0, unchanged: 0, conflicts: [] as { uid: string; start: string; end: string }[] };
  for (const ev of parseIcal(text)) {
    const exists = await db.query(`select 1 from bookings where room_id=$1 and external_uid=$2`, [roomId, ev.uid]);
    if (exists.rows.length) { out.unchanged++; continue; }
    try {
      await db.query(
        `insert into bookings (room_id, guests, during, status, source, external_uid)
         values ($1, 1, daterange($2::date,$3::date,'[)'), 'confirmed', 'ical', $4)`, [roomId, ev.start, ev.end, ev.uid]);
      out.imported++;
    } catch (e) {
      if (isOverlap(e)) out.conflicts.push(ev); else throw e;
    }
  }
  return out;
}
