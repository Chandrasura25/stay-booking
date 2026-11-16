const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseDay(s: string): number {
  if (!ISO.test(s)) throw new Error(`bad date "${s}", expected YYYY-MM-DD`);
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new Error(`bad date "${s}"`);
  return t;
}

/** Nights between check-in and check-out. Check-out day is NOT a night stayed. */
export function nights(checkIn: string, checkOut: string): number {
  const n = Math.round((parseDay(checkOut) - parseDay(checkIn)) / 86_400_000);
  if (n < 1) throw new Error("check-out must be after check-in");
  return n;
}
