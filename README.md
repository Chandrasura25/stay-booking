# stay-booking

The booking core for a small-stays marketplace (surf camps, boutique hotels, retreats): availability, holds, payments, calendar sync and search. TypeScript on Postgres. 24 tests.

It exists to answer one question: **how do you make double-booking impossible rather than unlikely?**

## The idea

A room cannot have two active stays that overlap, and the *database* enforces it, not the app:

```sql
exclude using gist (room_id with =, during with &&) where (status in ('held','confirmed'))
```

`during` is a half-open `daterange` (`[check-in, check-out)`), so one guest leaving the day the next arrives is fine, but any real overlap is refused. The application only translates Postgres's answer (`23P01`) into "those dates are no longer available". A test inserts an overlapping row with raw SQL to show the rule holds even when the app code is bypassed.

## What's here

| Piece | What it does | Tested |
|---|---|---|
| Availability | Exclusion constraint on room + date range | overlap, back-to-back, raw-SQL bypass, 10 simultaneous requests -> 1 winner |
| Holds | 15-minute payment window; expired holds free the dates | expiry, sweep |
| Payment webhooks | Stripe-style signed events (`t=...,v1=HMAC`), replay window, constant-time compare | bad/tampered/stale signature, **duplicate delivery changes nothing**, wrong amount, payment after expiry is flagged `needs_refund` and never silently re-booked |
| Search | Free for the whole range, by guests, price, amenities, city; cheapest first | each filter, expired holds don't block |
| iCal | Export a room's bookings (no guest details); import another calendar's blocks, idempotent by UID; collisions are reported, not forced | export, import, re-import, conflict, folded lines, round trip |

## Run

```
npm install
npm test
npm run typecheck
```

Postgres runs in-process through [PGlite](https://pglite.dev), so there is nothing to install or start.

## Honest limits

- The webhook uses a Stripe-**style** signature scheme with a shared secret. It is not wired to a live Stripe account.
- PGlite is a single in-process connection, so the "10 simultaneous requests" test shows the constraint rejects the losers, not a true multi-connection race. Against a real Postgres server the same exclusion constraint serialises concurrent inserts.
- No UI, auth, or host dashboard yet. This is the part that is hardest to get right, so it came first.
