export interface TimerEntry {
  label: string;
  agentId: string;
  message: string;
  delayMs: number;
  repeat: boolean;
  createdAt: string;
  nextFireAt: string;
}

export type TimerCallback = (agentId: string, message: string) => void;

export class TimerManager {
  private timers = new Map<string, { entry: TimerEntry; handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> }>();
  private callback: TimerCallback;

  constructor(callback: TimerCallback) {
    this.callback = callback;
  }

  setTimer(agentId: string, label: string, delayMs: number, message: string, repeat?: boolean): TimerEntry {
    // Cancel existing timer with same label
    this.cancelTimer(agentId, label);

    const now = new Date();
    const entry: TimerEntry = {
      label,
      agentId,
      message,
      delayMs,
      repeat: repeat ?? false,
      createdAt: now.toISOString(),
      nextFireAt: new Date(now.getTime() + delayMs).toISOString(),
    };

    const key = `${agentId}:${label}`;
    if (repeat) {
      const handle = setInterval(() => {
        this.callback(agentId, message);
        entry.nextFireAt = new Date(Date.now() + delayMs).toISOString();
      }, delayMs);
      this.timers.set(key, { entry, handle });
    } else {
      const handle = setTimeout(() => {
        this.callback(agentId, message);
        this.timers.delete(key);
      }, delayMs);
      this.timers.set(key, { entry, handle });
    }

    return entry;
  }

  cancelTimer(agentId: string, label: string): boolean {
    const key = `${agentId}:${label}`;
    const timer = this.timers.get(key);
    if (!timer) return false;
    if (timer.entry.repeat) {
      clearInterval(timer.handle);
    } else {
      clearTimeout(timer.handle);
    }
    this.timers.delete(key);
    return true;
  }

  listTimers(agentId?: string): TimerEntry[] {
    const result: TimerEntry[] = [];
    for (const { entry } of this.timers.values()) {
      if (!agentId || entry.agentId === agentId) {
        result.push(entry);
      }
    }
    return result;
  }

  clearAll(): void {
    for (const { entry, handle } of this.timers.values()) {
      if (entry.repeat) clearInterval(handle);
      else clearTimeout(handle);
    }
    this.timers.clear();
  }
}
