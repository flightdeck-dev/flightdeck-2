import { loadGlobalConfig } from '../config/GlobalConfig.js';

/** Format the current timestamp in the user's configured timezone as ISO with offset. */
export function formatTs(): string {
  try {
    const gc = loadGlobalConfig() as { timezone?: string };
    if (gc.timezone) {
      const tz = gc.timezone;
      const d = new Date();
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        timeZoneName: 'longOffset',
      }).formatToParts(d);
      const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
      const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
      return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
    }
  } catch { /* fall through to UTC */ }
  return new Date().toISOString().slice(0, 19) + 'Z';
}
