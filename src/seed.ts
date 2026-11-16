import type { Db } from "./db.js";

export async function seed(db: Db) {
  await db.exec(`
    insert into properties (name, kind, city) values
      ('Sunrise Surf Camp', 'surf camp', 'Taghazout'),
      ('Casa Olivar', 'boutique hotel', 'Lisbon'),
      ('Stillwater Retreat', 'retreat', 'Ericeira');
    insert into rooms (property_id, name, capacity, nightly_cents, amenities) values
      (1, 'Dorm bed', 1, 2500, '{wifi,surf lessons}'),
      (1, 'Private bungalow', 2, 9000, '{wifi,surf lessons,kitchen}'),
      (2, 'Garden double', 2, 14000, '{wifi,breakfast}'),
      (2, 'Suite', 3, 22000, '{wifi,breakfast,balcony}'),
      (3, 'Studio', 2, 12000, '{wifi,yoga,kitchen}');
  `);
}
