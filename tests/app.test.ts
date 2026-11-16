import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { listen } from "../src/app.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = await listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const json = (path: string, body?: unknown) =>
  fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const dates = { checkIn: "2027-03-10", checkOut: "2027-03-13" };

describe("HTTP API", () => {
  it("serves the page", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Stay Booking Demo");
  });

  it("searches, holds, rejects a second guest with 409, then confirms on payment", async () => {
    const s = await (await json(`/api/search?checkIn=${dates.checkIn}&checkOut=${dates.checkOut}&guests=2&city=lisbon`)).json();
    expect(s.rooms.map((r: { room: string }) => r.room)).toEqual(["Garden double", "Suite"]);

    const first = await json("/api/hold", { roomId: 3, guestEmail: "a@example.com", guests: 2, ...dates });
    expect(first.status).toBe(201);
    const { bookingId } = await first.json();

    const second = await json("/api/hold", { roomId: 3, guestEmail: "b@example.com", guests: 2, ...dates });
    expect(second.status).toBe(409);

    const paid = await (await json("/api/demo/pay", { bookingId })).json();
    expect(paid.result.status).toBe("confirmed");
    expect(paid.booking.status).toBe("confirmed");

    const again = await (await json("/api/demo/pay", { bookingId })).json();
    expect(again.result.status).toBe("duplicate");
  });

  it("rejects a forged webhook", async () => {
    const r = await (await json("/api/demo/bad-webhook", {})).json();
    expect(r.result).toMatchObject({ status: "rejected" });
  });

  it("returns 400 for bad dates and bad JSON, not a crash", async () => {
    expect((await json("/api/search?checkIn=nope&checkOut=2027-03-13")).status).toBe(400);
    expect((await json("/api/hold", { roomId: 1, guestEmail: "a@example.com", guests: 1, checkIn: "2027-03-13", checkOut: "2027-03-10" })).status).toBe(400);
    const bad = await fetch(base + "/api/hold", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("serves an iCal feed that includes the booking, with no guest email", async () => {
    const r = await fetch(base + "/api/rooms/3.ics");
    expect(r.headers.get("content-type")).toContain("text/calendar");
    const text = await r.text();
    expect(text).toContain("DTSTART;VALUE=DATE:20270310");
    expect(text).not.toContain("example.com");
  });

  it("reset restores a clean database", async () => {
    await json("/api/demo/reset", {});
    const s = await (await json(`/api/search?checkIn=${dates.checkIn}&checkOut=${dates.checkOut}&guests=2&city=lisbon`)).json();
    expect(s.rooms).toHaveLength(2);
  });
});
