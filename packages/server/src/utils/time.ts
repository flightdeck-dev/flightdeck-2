import { loadGlobalConfig } from '../config/GlobalConfig.js';

// Resolve the timezone + formatter once. formatTs() is a hot path (every
// user/agent DM envelope), and loadGlobalConfig() does synchronous filesystem
// reads — so we cache the result at module scope instead of re-reading per call.
let resolved = false;
let cachedFormatter: Intl.DateTimeFormat | null = null;

function getFormatter(): Intl.DateTimeFormat | null {
  if (!resolved) {
    resolved = true;
    try {
      const gc = loadGlobalConfig() as { timezone?: string };
      if (gc.timezone) {
        cachedFormatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: gc.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
          timeZoneName: 'longOffset',
        });
      }
    } catch { /* fall through to UTC */ }
  }
  return cachedFormatter;
}

/** Format the current timestamp in the user's configured timezone as ISO with offset. */
export function formatTs(): string {
  const formatter = getFormatter();
  if (formatter) {
    const parts = formatter.formatToParts(new Date());
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
  }
  return new Date().toISOString().slice(0, 19) + 'Z';
}
