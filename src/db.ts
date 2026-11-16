import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

// In-process Postgres (PGlite), so the demo and tests need no server. The point
// is the constraint below: the DATABASE refuses overlapping stays, so no bug in
// the application code can double-book a room.
export const SCHEMA = `
create extension if not exists btree_gist;

create table properties (
  id serial primary key,
  name text not null,
  kind text not null,
  city text not null
);

create table rooms (
  id serial primary key,
  property_id int not null references properties(id),
  name text not null,
  capacity int not null check (capacity > 0),
  nightly_cents int not null check (nightly_cents > 0),
  amenities text[] not null default '{}'
);

create table bookings (
  id serial primary key,
  room_id int not null references rooms(id),
  guest_email text,
  guests int not null default 1,
  during daterange not null check (not isempty(during) and upper(during) > lower(during)),
  status text not null check (status in ('held','confirmed','cancelled')),
  source text not null default 'direct' check (source in ('direct','ical')),
  external_uid text,
  hold_expires_at timestamptz,
  total_cents int not null default 0,
  created_at timestamptz not null default now(),
  -- the whole idea: a room cannot have two active stays that overlap.
  constraint no_double_booking
    exclude using gist (room_id with =, during with &&)
    where (status in ('held','confirmed')),
  unique (room_id, external_uid)
);

create table payment_events (
  event_id text primary key,
  booking_id int,
  outcome text not null,
  received_at timestamptz not null default now()
);
`;

export type Db = PGlite;

export async function createDb(): Promise<Db> {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(SCHEMA);
  return db;
}

export const isOverlap = (e: unknown) => (e as { code?: string })?.code === "23P01";
