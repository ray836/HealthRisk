/**
 * Timezone-aware timing for the daily turn window (§5).
 *
 * The window opens at a fixed local wall-clock time (e.g. 19:00) in the game's
 * IANA timezone, every day. Computing "the next instant at 19:00 local" correctly
 * across DST needs the zone's UTC offset *at that instant*, which we derive from
 * `Intl.DateTimeFormat` (no external tz library). Pure and deterministic.
 */

/** UTC offset (local - UTC) in milliseconds for `tz` at instant `date`. */
export function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = Number(p.value);
  const asUTC = Date.UTC(map.year!, map.month! - 1, map.day!, map.hour!, map.minute!, map.second!);
  return asUTC - date.getTime();
}

/** The local calendar Y/M/D for `tz` at instant `date`. */
function localYMD(tz: string, date: Date): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') map[p.type] = Number(p.value);
  return { year: map.year!, month: map.month!, day: map.day! };
}

/** The UTC instant for a given local wall-clock (Y/M/D + minute-of-day) in `tz`. */
export function zonedInstant(tz: string, year: number, month: number, day: number, minuteOfDay: number): Date {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  const asUTC = Date.UTC(year, month - 1, day, h, m);
  // local = utc + offset  =>  utc = asUTC - offset. Offset can shift across the
  // instant we're solving for, so refine once.
  let offset = tzOffsetMs(tz, new Date(asUTC));
  let instant = asUTC - offset;
  const offset2 = tzOffsetMs(tz, new Date(instant));
  if (offset2 !== offset) {
    offset = offset2;
    instant = asUTC - offset;
  }
  return new Date(instant);
}

/**
 * The next instant at or after `from` whose local time in `tz` is
 * `minuteOfDay`. Tries today's local date, then tomorrow.
 *
 * Note: minuteOfDay in the 1–3am DST spring-forward gap can be skipped or
 * doubled; the default 19:00 window is well clear of it.
 */
export function nextWindowStart(tz: string, minuteOfDay: number, from: Date): Date {
  const { year, month, day } = localYMD(tz, from);
  const today = zonedInstant(tz, year, month, day, minuteOfDay);
  if (today.getTime() >= from.getTime()) return today;
  // Advance one calendar day (via a noon anchor to dodge DST edges), re-read Y/M/D.
  const nextAnchor = new Date(zonedInstant(tz, year, month, day, 12 * 60).getTime() + 24 * 60 * 60 * 1000);
  const n = localYMD(tz, nextAnchor);
  return zonedInstant(tz, n.year, n.month, n.day, minuteOfDay);
}

/** The configured wall-clock on the following local calendar day. */
export function nextDayWindowStart(tz: string, minuteOfDay: number, from: Date): Date {
  const { year, month, day } = localYMD(tz, from);
  const nextAnchor = new Date(
    zonedInstant(tz, year, month, day, 12 * 60).getTime() + 24 * 60 * 60 * 1000,
  );
  const next = localYMD(tz, nextAnchor);
  return zonedInstant(tz, next.year, next.month, next.day, minuteOfDay);
}

/** The deadline for a player's window: `from` + `minutes`. */
export function windowDeadline(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * 60 * 1000);
}
