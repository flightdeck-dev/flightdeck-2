export function log(component: string, message: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.error(`[${ts}] [${component}] ${message}`, ...args);
}

export function truncate(s: string, max = 100): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}
