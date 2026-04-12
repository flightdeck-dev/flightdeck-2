import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimerManager } from '../../src/orchestrator/TimerManager.js';

describe('TimerManager', () => {
  let manager: TimerManager;
  let fired: Array<{ agentId: string; message: string }>;

  beforeEach(() => {
    fired = [];
    manager = new TimerManager((agentId, message) => {
      fired.push({ agentId, message });
    });
  });

  afterEach(() => {
    manager.clearAll();
  });

  it('sets and fires a one-shot timer', async () => {
    manager.setTimer('agent-1', 'reminder', 50, 'time to check');
    expect(manager.listTimers()).toHaveLength(1);
    await new Promise(r => setTimeout(r, 100));
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toBe('time to check');
    // Timer should be removed after firing
    expect(manager.listTimers()).toHaveLength(0);
  });

  it('cancels a timer', async () => {
    manager.setTimer('agent-1', 'cancel-me', 50, 'should not fire');
    expect(manager.cancelTimer('agent-1', 'cancel-me')).toBe(true);
    await new Promise(r => setTimeout(r, 100));
    expect(fired).toHaveLength(0);
  });

  it('lists timers filtered by agent', () => {
    manager.setTimer('agent-1', 't1', 10000, 'msg1');
    manager.setTimer('agent-2', 't2', 10000, 'msg2');
    expect(manager.listTimers('agent-1')).toHaveLength(1);
    expect(manager.listTimers('agent-2')).toHaveLength(1);
    expect(manager.listTimers()).toHaveLength(2);
  });

  it('returns false when cancelling nonexistent timer', () => {
    expect(manager.cancelTimer('agent-1', 'nope')).toBe(false);
  });

  it('replaces timer with same label', () => {
    manager.setTimer('agent-1', 'dup', 10000, 'first');
    manager.setTimer('agent-1', 'dup', 10000, 'second');
    const timers = manager.listTimers('agent-1');
    expect(timers).toHaveLength(1);
    expect(timers[0].message).toBe('second');
  });

  it('repeat timer fires multiple times', async () => {
    manager.setTimer('agent-1', 'repeater', 30, 'ping', true);
    await new Promise(r => setTimeout(r, 120));
    expect(fired.length).toBeGreaterThanOrEqual(2);
    // Timer should still be listed
    expect(manager.listTimers()).toHaveLength(1);
  });
});
