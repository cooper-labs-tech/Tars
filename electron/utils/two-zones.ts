/**
 * A time as every notice Tars types into an agent says it (2.0.6, option d): UTC first, then the machine's own time
 * with its offset, "19:03 UTC (23:03 +04)". An agent's transcript, tools and CI speak UTC, its user the machine's zone:
 * said in one only, a notice read hours off. A machine on UTC says it once.
 *
 * `offsetMinutes`: the machine's offset east of UTC at that instant, by default its own (getTimezoneOffset is UTC
 * minus local, hence the sign).
 */
export function twoZones(ms: number, offsetMinutes = -new Date(ms).getTimezoneOffset()): string {
  const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const utc = hhmm(new Date(ms));
  if (offsetMinutes === 0) return `${utc} UTC`;
  const local = hhmm(new Date(ms + offsetMinutes * 60_000));
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : '';
  return `${utc} UTC (${local} ${offsetMinutes > 0 ? '+' : '-'}${hours}${minutes})`;
}
