import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore, type SessionEntry } from '../../src/acp/SessionStore.js';

const TEST_PROJECT = `test-session-store-${Date.now()}`;
const BASE_DIR = path.join(os.homedir(), '.flightdeck', 'v2', 'projects', TEST_PROJECT, 'sessions');

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(TEST_PROJECT);
  });

  afterEach(() => {
    // Clean up test files
    try { fs.rmSync(path.join(os.homedir(), '.flightdeck', 'v2', 'projects', TEST_PROJECT), { recursive: true, force: true }); } catch {}
  });

  it('should create and list sessions', () => {
    const s1 = store.createSession(TEST_PROJECT, '/tmp/a');
    const s2 = store.createSession(TEST_PROJECT, '/tmp/b');

    const sessions = store.listSessions(TEST_PROJECT);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(s1.id);
    expect(sessions[1].id).toBe(s2.id);
  });

  it('should list all sessions', () => {
    store.createSession('proj-a', '/tmp/a');
    store.createSession('proj-b', '/tmp/b');

    const all = store.listAll();
    expect(all).toHaveLength(2);
  });

  it('should get a specific session', () => {
    const s = store.createSession(TEST_PROJECT, '/tmp/a');
    const found = store.getSession(s.id);
    expect(found).toBeDefined();
    expect(found!.cwd).toBe('/tmp/a');
  });

  it('should return undefined for unknown session', () => {
    expect(store.getSession('nonexistent')).toBeUndefined();
  });

  it('should append and read events', () => {
    const s = store.createSession(TEST_PROJECT, '/tmp/a');
    store.appendEvent(s.id, { role: 'user', content: 'hello', ts: 1000 });
    store.appendEvent(s.id, { role: 'agent', content: 'hi there', ts: 2000 });

    const events = store.readEvents(s.id);
    expect(events).toHaveLength(2);
    expect(events[0].role).toBe('user');
    expect(events[1].content).toBe('hi there');
  });

  it('should update lastActive timestamp', async () => {
    const s = store.createSession(TEST_PROJECT, '/tmp/a');
    const before = s.lastActiveAt;

    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 10));
    store.updateLastActive(s.id);
    const after = store.getSession(s.id)!.lastActiveAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('should filter listSessions by project name', () => {
    store.createSession('proj-x', '/tmp/a');
    store.createSession('proj-y', '/tmp/b');
    store.createSession('proj-x', '/tmp/c');

    const x = store.listSessions('proj-x');
    expect(x).toHaveLength(2);

    const y = store.listSessions('proj-y');
    expect(y).toHaveLength(1);
  });
});
