import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LeadManager } from '../../src/lead/LeadManager.js';
import { SqliteStore } from '../../src/storage/SqliteStore.js';
import { ProjectStore } from '../../src/storage/ProjectStore.js';
import { MessageStore, type ChatMessage } from '../../src/comms/MessageStore.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    threadId: null,
    parentId: null,
    taskId: null,
    authorType: 'user',
    authorId: 'user-1',
    content: 'Hello from user',
    metadata: null,
    channel: null,
    recipient: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    ...overrides,
  };
}

describe('LeadManager steer messages', () => {
  const projectName = `test-steer-${Date.now()}`;
  let project: ProjectStore;
  let sqlite: SqliteStore;
  let messageStore: MessageStore;
  let lm: LeadManager;

  beforeEach(() => {
    project = new ProjectStore(projectName);
    if (!project.exists()) project.init(projectName);
    project.ensureDirs();
    sqlite = new SqliteStore(project.subpath('state.sqlite'));

    // MessageStore shares the same DB (tables created by SqliteStore.migrate)
    messageStore = new MessageStore(sqlite.db);

    const mockAdapter = {
      spawn: async () => ({ agentId: 'lead-1', sessionId: 'sess-1', status: 'running' }),
      steer: async () => '',
      getSession: () => null,
    };

    lm = new LeadManager({
      sqlite,
      project,
      messageStore,
      acpAdapter: mockAdapter,
    });
  });

  afterEach(() => {
    sqlite?.close();
    const projDir = join(homedir(), '.flightdeck', 'v2', 'projects', projectName);
    if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true });

  });

  describe('user_message', () => {
    it('includes timestamp and [USER] tag', () => {
      const steer = lm.buildSteer({
        type: 'user_message',
        message: makeChatMessage(),
      });
      expect(steer).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\]]*\] \[USER\]/);
    });

    it('includes message_id', () => {
      const steer = lm.buildSteer({
        type: 'user_message',
        message: makeChatMessage({ id: 'msg-42' }),
      });
      expect(steer).toContain('message_id: msg-42');
    });

    it('includes source: web-dashboard', () => {
      const steer = lm.buildSteer({
        type: 'user_message',
        message: makeChatMessage(),
      });
      expect(steer).toContain('source: web-dashboard');
    });

    it('includes the actual message content', () => {
      const steer = lm.buildSteer({
        type: 'user_message',
        message: makeChatMessage({ content: 'Please fix the bug in auth.ts' }),
      });
      expect(steer).toContain('Please fix the bug in auth.ts');
    });

    it('does NOT contain instructions like "For project status" or "read .flightdeck"', () => {
      const steer = lm.buildSteer({
        type: 'user_message',
        message: makeChatMessage({ content: 'What is the status?' }),
      });
      expect(steer).not.toContain('For project status');
      expect(steer).not.toContain('read .flightdeck');
    });

    it('does NOT contain "status.md"', () => {
      const steer = lm.buildSteer({
        type: 'user_message',
        message: makeChatMessage({ content: 'Give me a summary' }),
      });
      expect(steer).not.toContain('status.md');
    });

    it('includes reply_to when parentId is set', () => {
      const steer = lm.buildSteer({
        type: 'user_message',
        message: makeChatMessage({ parentId: 'parent-msg-1' }),
      });
      expect(steer).toContain('reply_to: parent-msg-1');
    });

    it('includes quoted_message when parent message exists in MessageStore', () => {
      // Insert a parent message
      const parent = messageStore.createMessage({
        threadId: null,
        parentId: null,
        taskId: null,
        authorType: 'lead',
        authorId: 'lead-1',
        content: 'This is the original message that was sent earlier',
      });

      const steer = lm.buildSteer({
        type: 'user_message',
        message: makeChatMessage({ parentId: parent.id }),
      });
      expect(steer).toContain('quoted_message: This is the original message that was sent earlier');
    });

    it('truncates quoted_message to 200 chars with "..." suffix', () => {
      const longContent = 'A'.repeat(300);
      const parent = messageStore.createMessage({
        threadId: null,
        parentId: null,
        taskId: null,
        authorType: 'lead',
        authorId: 'lead-1',
        content: longContent,
      });

      const steer = lm.buildSteer({
        type: 'user_message',
        message: makeChatMessage({ parentId: parent.id }),
      });
      expect(steer).toContain('quoted_message: ' + 'A'.repeat(200) + '...');
      expect(steer).not.toContain('A'.repeat(201));
    });
  });

  describe('task_comment', () => {
    it('contains [USER] tag (task comments are from users)', () => {
      const steer = lm.buildSteer({
        type: 'task_comment',
        taskId: 'task-99',
        message: makeChatMessage({ content: 'Please reconsider the approach' }),
      });
      // task_comment uses [USER] tag
      expect(steer).toContain('[USER]');
    });

    it('contains task_id', () => {
      const steer = lm.buildSteer({
        type: 'task_comment',
        taskId: 'task-99',
        message: makeChatMessage(),
      });
      expect(steer).toContain('task_id: task-99');
    });

    it('contains source: task_comment', () => {
      const steer = lm.buildSteer({
        type: 'task_comment',
        taskId: 'task-99',
        message: makeChatMessage(),
      });
      expect(steer).toContain('source: task_comment');
    });
  });

  describe('task_failure', () => {
    it('contains [SYSTEM] tag', () => {
      const steer = lm.buildSteer({
        type: 'task_failure',
        taskId: 'task-fail-1',
        error: 'Tests failed',
      });
      expect(steer).toContain('[SYSTEM]');
    });

    it('contains task_id', () => {
      const steer = lm.buildSteer({
        type: 'task_failure',
        taskId: 'task-fail-1',
        error: 'Tests failed',
      });
      expect(steer).toContain('task_id: task-fail-1');
    });

    it('contains source: task_failure', () => {
      const steer = lm.buildSteer({
        type: 'task_failure',
        taskId: 'task-fail-1',
        error: 'Tests failed',
      });
      expect(steer).toContain('source: task_failure');
    });
  });

  describe('escalation', () => {
    it('contains [AGENT] tag with agent_id', () => {
      const steer = lm.buildSteer({
        type: 'escalation',
        agentId: 'worker-7',
        taskId: 'task-esc-1',
        reason: 'Cannot resolve merge conflict',
      });
      expect(steer).toContain('[AGENT worker-7]');
    });

    it('contains agent_id field', () => {
      const steer = lm.buildSteer({
        type: 'escalation',
        agentId: 'worker-7',
        taskId: 'task-esc-1',
        reason: 'Cannot resolve merge conflict',
      });
      expect(steer).toContain('agent_id: worker-7');
    });

    it('contains task_id', () => {
      const steer = lm.buildSteer({
        type: 'escalation',
        agentId: 'worker-7',
        taskId: 'task-esc-1',
        reason: 'Cannot resolve merge conflict',
      });
      expect(steer).toContain('task_id: task-esc-1');
    });

    it('contains source: escalation', () => {
      const steer = lm.buildSteer({
        type: 'escalation',
        agentId: 'worker-7',
        taskId: 'task-esc-1',
        reason: 'Cannot resolve merge conflict',
      });
      expect(steer).toContain('source: escalation');
    });
  });

  describe('status injection at spawn', () => {
    it('includes task counts and agents in spawn system prompt', async () => {
      const capturedSystemPrompts: string[] = [];
      const mockAdapter = {
        spawn: async (opts: any) => {
          capturedSystemPrompts.push(opts.systemPrompt ?? '');
          return { agentId: `agent-${capturedSystemPrompts.length}`, sessionId: `sess-${capturedSystemPrompts.length}`, status: 'running' };
        },
        steer: async () => '',
        getSession: () => null,
      };

      const spawnLm = new LeadManager({
        sqlite,
        project,
        acpAdapter: mockAdapter,
      });

      await spawnLm.spawnLead();

      // First spawn is Lead, which gets the status prompt
      const leadPrompt = capturedSystemPrompts[0];
      expect(leadPrompt).toContain('## Current Project Status');
      expect(leadPrompt).toContain('Tasks:');
      expect(leadPrompt).toMatch(/\d+ running/);
      expect(leadPrompt).toMatch(/\d+ ready/);
      expect(leadPrompt).toMatch(/\d+ done/);
      expect(leadPrompt).toMatch(/\d+ failed/);
      expect(leadPrompt).toMatch(/Agents:/);
    });
  });
});
