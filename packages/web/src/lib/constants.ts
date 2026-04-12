/** Shared task state → CSS color variable mapping */
export const STATE_COLORS: Record<string, string> = {
  pending: 'var(--color-status-ready)',
  ready: 'var(--color-status-ready)',
  running: 'var(--color-status-running)',
  in_review: 'var(--color-status-in-review)',
  done: 'var(--color-status-done)',
  failed: 'var(--color-status-failed)',
  cancelled: 'var(--color-status-cancelled)',
  paused: 'var(--color-text-tertiary)',
  skipped: 'var(--color-text-tertiary)',
};

/** Max messages to keep in chat buffer */
export const MAX_MESSAGES = 500;

/** Polling/reconnect constants */
export const WS_INITIAL_BACKOFF_MS = 1000;
export const WS_MAX_BACKOFF_MS = 30000;
