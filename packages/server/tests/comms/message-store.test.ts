import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Flightdeck } from '../../src/facade.js';
import { MessageStore } from '../../src/comms/MessageStore.js';

describe('MessageStore', () => {
  let fd: Flightdeck;
  let store: MessageStore;
  const projectName = `test-msgstore-${Date.now()}`;

  beforeEach(() => {
    fd = new Flightdeck(projectName);
    store = new MessageStore(fd.sqlite.db);
  });

  afterEach(() => {
    fd.close();
    const projDir = join(homedir(), '.flightdeck', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });
  });

  it('creates and retrieves a message', () => {
    const msg = store.createMessage({
      authorType: 'user',
      authorId: 'user',
      content: 'Hello world',
      threadId: null,
      parentId: null,
      taskId: null,
      metadata: null,
    });
    expect(msg.id).toBeTruthy();
    expect(msg.content).toBe('Hello world');

    const retrieved = store.getMessage(msg.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe('Hello world');
  });

  it('lists messages with filters', () => {
    store.createMessage({ authorType: 'user', authorId: 'user', content: 'msg1', threadId: null, parentId: null, taskId: null, metadata: null });
    store.createMessage({ authorType: 'lead', authorId: 'lead-1', content: 'msg2', threadId: null, parentId: null, taskId: 'task-1', metadata: null });
    store.createMessage({ authorType: 'agent', authorId: 'worker-1', content: 'msg3', threadId: null, parentId: null, taskId: 'task-1', metadata: null });

    const all = store.listMessages();
    expect(all.length).toBe(3);

    const taskMsgs = store.listMessages({ taskId: 'task-1' });
    expect(taskMsgs.length).toBe(2);

    const limited = store.listMessages({ limit: 1 });
    expect(limited.length).toBe(1);
  });

  it('creates and lists threads', () => {
    const msg = store.createMessage({ authorType: 'user', authorId: 'user', content: 'start', threadId: null, parentId: null, taskId: null, metadata: null });
    const thread = store.createThread({ originId: msg.id, title: 'Test thread' });
    expect(thread.id).toBeTruthy();
    expect(thread.title).toBe('Test thread');

    const retrieved = store.getThread(thread.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.originId).toBe(msg.id);

    const threads = store.listThreads();
    expect(threads.length).toBe(1);
  });

  it('filters threads by archived status', () => {
    const msg = store.createMessage({ authorType: 'user', authorId: 'user', content: 'x', threadId: null, parentId: null, taskId: null, metadata: null });
    store.createThread({ originId: msg.id, title: 'Active' });

    const active = store.listThreads({ archived: false });
    expect(active.length).toBe(1);

    const archived = store.listThreads({ archived: true });
    expect(archived.length).toBe(0);
  });

  it('supports replies via parentId', () => {
    const parent = store.createMessage({ authorType: 'user', authorId: 'user', content: 'question', threadId: null, parentId: null, taskId: null, metadata: null });
    const reply = store.createMessage({ authorType: 'lead', authorId: 'lead-1', content: 'answer', threadId: null, parentId: parent.id, taskId: null, metadata: null });
    expect(reply.parentId).toBe(parent.id);
  });
});
