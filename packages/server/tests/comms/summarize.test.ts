import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageStore } from '../../src/comms/MessageStore.js';
import { DecisionLog } from '../../src/storage/DecisionLog.js';
import { createDatabase } from '../../src/db/database.js';

describe('Group Chat Auto-Summarize (FR-021b)', () => {
  let msgStore: MessageStore;
  let decisionLog: DecisionLog;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fd-summarize-'));
    const db = createDatabase(join(tmpDir, 'test.sqlite'));
    msgStore = new MessageStore(db);
    decisionLog = new DecisionLog(join(tmpDir, 'decisions'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('summarizes a thread with messages', () => {
    // Create a thread
    const msg1 = msgStore.createMessage({
      threadId: null,
      parentId: null,
      taskId: null,
      authorType: 'agent',
      authorId: 'agent-1',
      content: 'Should we use REST or GraphQL?',
    });
    const thread = msgStore.createThread({ originId: msg1.id, title: 'API Design Discussion' });

    // Add messages to the thread
    msgStore.createMessage({
      threadId: thread.id,
      parentId: null,
      taskId: null,
      authorType: 'agent',
      authorId: 'agent-2',
      content: 'I think REST is simpler for our use case.',
    });
    msgStore.createMessage({
      threadId: thread.id,
      parentId: null,
      taskId: null,
      authorType: 'agent',
      authorId: 'agent-1',
      content: 'Agreed. Let\'s go with REST.',
    });

    const { summary, messageCount } = msgStore.summarizeThread(thread.id);
    expect(messageCount).toBe(2);
    expect(summary).toContain('API Design Discussion');
    expect(summary).toContain('agent-1');
    expect(summary).toContain('agent-2');
    expect(summary).toContain('REST');
  });

  it('handles empty threads', () => {
    const msg = msgStore.createMessage({
      threadId: null,
      parentId: null,
      taskId: null,
      authorType: 'user',
      authorId: 'user-1',
      content: 'start',
    });
    const thread = msgStore.createThread({ originId: msg.id, title: 'Empty' });

    const { summary, messageCount } = msgStore.summarizeThread(thread.id);
    expect(messageCount).toBe(0);
    expect(summary).toBe('No messages in thread.');
  });

  it('summary can be stored in decision log', () => {
    const msg = msgStore.createMessage({
      threadId: null,
      parentId: null,
      taskId: null,
      authorType: 'agent',
      authorId: 'agent-1',
      content: 'discussion message',
    });
    const thread = msgStore.createThread({ originId: msg.id, title: 'Design Chat' });
    msgStore.createMessage({
      threadId: thread.id,
      parentId: null,
      taskId: null,
      authorType: 'agent',
      authorId: 'agent-1',
      content: 'We decided on option A',
    });

    const { summary } = msgStore.summarizeThread(thread.id);

    decisionLog.append({
      id: 'decision-1' as any,
      taskId: 'task-1' as any,
      agentId: 'system' as any,
      type: 'technical' as any,
      title: 'Thread summary: Design Chat',
      reasoning: summary,
      alternatives: [],
      confidence: 1.0,
      reversible: false,
      timestamp: new Date().toISOString(),
      status: 'auto_approved' as any,
    });

    const decisions = decisionLog.readAll();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].reasoning).toContain('Design Chat');
  });

  it('collectThread returns structured data', () => {
    const msg = msgStore.createMessage({
      threadId: null,
      parentId: null,
      taskId: null,
      authorType: 'agent',
      authorId: 'agent-1',
      content: 'hello',
    });
    const thread = msgStore.createThread({ originId: msg.id, title: 'Test' });
    msgStore.createMessage({
      threadId: thread.id,
      parentId: null,
      taskId: null,
      authorType: 'agent',
      authorId: 'agent-1',
      content: 'world',
    });

    const result = msgStore.collectThread(thread.id);
    expect(result.thread).toBeTruthy();
    expect(result.messages).toHaveLength(1);
    expect(result.digest).toContain('world');
  });
});
