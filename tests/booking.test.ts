import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db.js";
import { seed } from "../src/seed.js";
import {
  BookingError, exportIcal, getBooking, handlePaymentWebhook, importIcal, parseIcal,
  placeHold, search, signPayload, sweepExpiredHolds, verifySignature,
} from "../src/service.js";

const SECRET = "whsec_test";
const NOW = new Date("2026-12-01T10:00:00Z");
let db: Db;

beforeEach(async () => { db = await createDb(); await seed(db); });

const hold = (over: Partial<Parameters<typeof placeHold>[1]> = {}, now = NOW) =>
  placeHold(db, { roomId: 2, guestEmail: "a@example.com", guests: 2, checkIn: "2027-01-10", checkOut: "2027-01-14", ...over }, now);

function paymentEvent(id: string, bookingId: number, amountCents: number) {
  const body = JSON.stringify({ id, type: "payment.succeeded", data: { booking_id: bookingId, amount_cents: amountCents } });
  return { body, header: signPayload(body, SECRET, Math.floor(NOW.getTime() / 1000)) };
}

describe("availability is enforced by the database", () => {
  it("prices a hold by nights (check-out day is not a night)", async () => {
    const h = await hold();
    expect(h.totalCents).toBe(4 * 9000);
  });

  it("rejects an overlapping stay", async () => {
    await hold();
    await expect(hold({ guestEmail: "b@example.com", checkIn: "2027-01-12", checkOut: "2027-01-16" }))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("allows back-to-back stays: one guest leaves the day the next arrives", async () => {
    await hold();
    await expect(hold({ guestEmail: "b@example.com", checkIn: "2027-01-14", checkOut: "2027-01-16" })).resolves.toBeTruthy();
    await expect(hold({ guestEmail: "c@example.com", checkIn: "2027-01-08", checkOut: "2027-01-10" })).resolves.toBeTruthy();
  });

  it("lets exactly one of ten simultaneous requests win", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => hold({ guestEmail: `g${i}@example.com` })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(9);
    expect(rejected.every((r) => r.reason instanceof BookingError && r.reason.code === "unavailable")).toBe(true);
  });

  it("refuses an overlap even when application code is bypassed (raw SQL)", async () => {
    await hold();
    await expect(db.query(
      `insert into bookings (room_id, guests, during, status) values (2, 1, daterange('2027-01-11','2027-01-12','[)'), 'confirmed')`,
    )).rejects.toMatchObject({ code: "23P01" });
  });

  it("rejects bad input: capacity, dates, email", async () => {
    await expect(hold({ guests: 5 })).rejects.toMatchObject({ code: "invalid" });
    await expect(hold({ checkOut: "2027-01-10" })).rejects.toThrow(/after check-in/);
    await expect(hold({ checkIn: "2027-02-30", checkOut: "2027-03-02" })).rejects.toThrow(/bad date/);
    await expect(hold({ guestEmail: "nope" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("holds", () => {
  it("frees the dates when the payment window passes", async () => {
    await hold();
    const later = new Date(NOW.getTime() + 16 * 60_000);
    await expect(hold({ guestEmail: "b@example.com" }, new Date(NOW.getTime() + 5 * 60_000)))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(hold({ guestEmail: "b@example.com" }, later)).resolves.toBeTruthy();
  });

  it("sweeps expired holds and reports how many", async () => {
    await hold();
    expect(await sweepExpiredHolds(db, new Date(NOW.getTime() + 20 * 60_000))).toBe(1);
  });
});

describe("payment webhooks", () => {
  it("confirms a held booking on a correctly signed event", async () => {
    const h = await hold();
    const { body, header } = paymentEvent("evt_1", h.bookingId, h.totalCents);
    expect(await handlePaymentWebhook(db, body, header, SECRET, NOW)).toEqual({ status: "confirmed" });
    expect((await getBooking(db, h.bookingId)).status).toBe("confirmed");
  });

  it("is safe to deliver twice: the retry changes nothing", async () => {
    const h = await hold();
    const { body, header } = paymentEvent("evt_1", h.bookingId, h.totalCents);
    await handlePaymentWebhook(db, body, header, SECRET, NOW);
    expect(await handlePaymentWebhook(db, body, header, SECRET, NOW)).toEqual({ status: "duplicate" });
    const n = await db.query(`select count(*)::int c from payment_events`);
    expect((n.rows[0] as { c: number }).c).toBe(1);
  });

  it("rejects a bad signature, a tampered body, and a stale timestamp", async () => {
    const h = await hold();
    const { body, header } = paymentEvent("evt_1", h.bookingId, h.totalCents);
    expect(await handlePaymentWebhook(db, body, "t=1,v1=" + "0".repeat(64), SECRET, NOW)).toMatchObject({ status: "rejected" });
    expect(await handlePaymentWebhook(db, body.replace(`${h.totalCents}`, "1"), header, SECRET, NOW)).toMatchObject({ status: "rejected" });
    const stale = signPayload(body, SECRET, Math.floor(NOW.getTime() / 1000) - 3600);
    expect(await handlePaymentWebhook(db, body, stale, SECRET, NOW)).toMatchObject({ status: "rejected" });
    expect(await handlePaymentWebhook(db, body, undefined, SECRET, NOW)).toMatchObject({ status: "rejected" });
    expect((await getBooking(db, h.bookingId)).status).toBe("held");
  });

  it("refuses to confirm when the amount paid does not match", async () => {
    const h = await hold();
    const { body, header } = paymentEvent("evt_1", h.bookingId, h.totalCents - 100);
    expect(await handlePaymentWebhook(db, body, header, SECRET, NOW)).toEqual({ status: "amount_mismatch" });
    expect((await getBooking(db, h.bookingId)).status).toBe("held");
  });

  it("flags a payment that arrives after the hold expired instead of re-booking", async () => {
    const h = await hold();
    const late = new Date(NOW.getTime() + 30 * 60_000);
    const body = JSON.stringify({ id: "evt_late", type: "payment.succeeded", data: { booking_id: h.bookingId, amount_cents: h.totalCents } });
    const header = signPayload(body, SECRET, Math.floor(late.getTime() / 1000));
    expect(await handlePaymentWebhook(db, body, header, SECRET, late)).toEqual({ status: "needs_refund" });
    expect((await getBooking(db, h.bookingId)).status).toBe("cancelled");
  });

  it("ignores event types it does not handle", async () => {
    const body = JSON.stringify({ id: "evt_x", type: "customer.created", data: {} });
    expect(await handlePaymentWebhook(db, body, signPayload(body, SECRET, Math.floor(NOW.getTime() / 1000)), SECRET, NOW))
      .toEqual({ status: "ignored" });
  });

  it("verifySignature is constant-shape: malformed headers are simply false", () => {
    expect(verifySignature("x", "garbage", SECRET)).toBe(false);
  });
});

describe("search", () => {
  it("returns only rooms free for the whole range, cheapest first", async () => {
    const all = await search(db, { checkIn: "2027-01-10", checkOut: "2027-01-14", guests: 2 }, NOW);
    expect(all.map((r) => r.room)).toEqual(["Private bungalow", "Studio", "Garden double", "Suite"]);
    await hold();
    const after = await search(db, { checkIn: "2027-01-12", checkOut: "2027-01-13", guests: 2 }, NOW);
    expect(after.map((r) => r.room)).not.toContain("Private bungalow");
  });

  it("filters by guests, price, amenities and city", async () => {
    const q = { checkIn: "2027-01-10", checkOut: "2027-01-12" };
    expect((await search(db, { ...q, guests: 3 }, NOW)).map((r) => r.room)).toEqual(["Suite"]);
    expect((await search(db, { ...q, maxNightlyCents: 10000 }, NOW)).map((r) => r.room)).toEqual(["Dorm bed", "Private bungalow"]);
    expect((await search(db, { ...q, amenities: ["yoga"] }, NOW)).map((r) => r.room)).toEqual(["Studio"]);
    expect((await search(db, { ...q, city: "lisbon" }, NOW)).map((r) => r.room)).toEqual(["Garden double", "Suite"]);
  });

  it("totals the stay and does not show a room whose hold has expired as taken", async () => {
    await hold();
    const later = new Date(NOW.getTime() + 20 * 60_000);
    const r = await search(db, { checkIn: "2027-01-10", checkOut: "2027-01-13", guests: 2 }, later);
    const bungalow = r.find((x) => x.room === "Private bungalow");
    expect(bungalow?.totalCents).toBe(3 * 9000);
  });
});

describe("iCal sync", () => {
  const feed = (events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
  const vevent = (uid: string, s: string, e: string) =>
    `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${s}\r\nDTEND;VALUE=DATE:${e}\r\nSUMMARY:Reserved\r\nEND:VEVENT`;

  it("exports bookings with no guest details", async () => {
    const h = await hold();
    const ics = await exportIcal(db, 2);
    expect(ics).toContain(`UID:booking-${h.bookingId}@stay-booking`);
    expect(ics).toContain("DTSTART;VALUE=DATE:20270110");
    expect(ics).toContain("DTEND;VALUE=DATE:20270114");
    expect(ics).not.toContain("a@example.com");
  });

  it("importing a feed blocks those dates for direct bookings", async () => {
    const r = await importIcal(db, 2, feed([vevent("airbnb-1", "20270110", "20270113")]));
    expect(r).toMatchObject({ imported: 1, unchanged: 0, conflicts: [] });
    await expect(hold()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("re-importing the same feed changes nothing", async () => {
    const f = feed([vevent("airbnb-1", "20270110", "20270113"), vevent("airbnb-2", "20270120", "20270122")]);
    await importIcal(db, 2, f);
    expect(await importIcal(db, 2, f)).toMatchObject({ imported: 0, unchanged: 2 });
    const n = await db.query(`select count(*)::int c from bookings`);
    expect((n.rows[0] as { c: number }).c).toBe(2);
  });

  it("reports a block that collides with a real booking instead of forcing it in", async () => {
    await hold();
    const r = await importIcal(db, 2, feed([vevent("ext-9", "20270112", "20270115"), vevent("ext-10", "20270201", "20270203")]));
    expect(r.imported).toBe(1);
    expect(r.conflicts).toEqual([{ uid: "ext-9", start: "2027-01-12", end: "2027-01-15" }]);
  });

  it("handles folded lines and date-time values", () => {
    const text = "BEGIN:VEVENT\r\nUID:long-\r\n uid-1\r\nDTSTART:20270110T150000Z\r\nDTEND:20270112T100000Z\r\nEND:VEVENT";
    expect(parseIcal(text)).toEqual([{ uid: "long-uid-1", start: "2027-01-10", end: "2027-01-12" }]);
  });

  it("round-trips: our export imports cleanly into another room as blocks", async () => {
    await hold();
    const ics = await exportIcal(db, 2);
    const r = await importIcal(db, 1, ics);
    expect(r.imported).toBe(1);
  });
});
