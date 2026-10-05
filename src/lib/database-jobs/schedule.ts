import { z } from 'zod'

export const jobTimezoneSchema = z.string().min(1).max(80).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/).refine(value => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true } catch { return false }
}, 'Fuso IANA inválido.')
export function dailySchedule(schedule: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule)
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return null
  return { hour: Number(match[2]), minute: Number(match[1]) }
}
/** A nonexistent local minute is skipped; the repeated minute on a DST fold runs
 * only once per local date. The SQL dispatcher uses the same calendar rule. */
export function nextDailyRuns(schedule: string, timezone: string, after: Date, count = 3): string[] {
  const daily = dailySchedule(schedule)
  if (!daily || !Number.isFinite(after.getTime())) throw new Error('Use um horário diário válido.')
  jobTimezoneSchema.parse(timezone); z.number().int().min(1).max(7).parse(count)
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const result: string[] = [], dates = new Set<string>()
  // Include the current local date's earlier fold occurrence, so the second
  // occurrence isn't advertised after its first occurrence has already passed.
  const start = Math.floor(after.getTime() / 60000) * 60000 - 26 * 3600000
  for (let stamp = start; stamp <= after.getTime() + 10 * 86400000 && result.length < count; stamp += 60000) {
    const parts = Object.fromEntries(formatter.formatToParts(stamp).map(part => [part.type, part.value]))
    if (Number(parts.hour) !== daily.hour || Number(parts.minute) !== daily.minute) continue
    const date = `${parts.year}-${parts.month}-${parts.day}`
    if (dates.has(date)) continue
    dates.add(date)
    if (stamp > after.getTime()) result.push(new Date(stamp).toISOString())
  }
  return result
}
