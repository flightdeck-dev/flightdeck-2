import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WebhookNotifier,
  taskCompletedEvent,
  taskFailedEvent,
  specCompletedEvent,
  escalationEvent,
  dailyReportEvent,
  agentStallEvent,
  budgetWarningEvent,
  agentMessageEvent,
  leadResponseEvent,
  type WebhookEvent,
  type NotificationsConfig,
} from '../../src/integrations/WebhookNotifier.js';
import type { ProjectConfig } from '@flightdeck-ai/shared';

const config: ProjectConfig = {
  name: 'test-project',
  governance: 'autonomous',
  isolation: 'none',
  onCompletion: 'stop',
};

describe('WebhookNotifier', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends to matching webhooks only', () => {
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://discord.com/api/webhooks/123/abc', events: ['task_completed', 'task_failed'] },
        { url: 'https://hooks.slack.com/services/x/y/z', events: ['escalation'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications, { debounceMs: 0 });

    const sent = notifier.notify(taskCompletedEvent('test', 'Build auth', 'worker-1'));
    expect(sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('discord.com');
  });

  it('debounces duplicate events to same webhook', () => {
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://discord.com/api/webhooks/123/abc', events: ['task_completed'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications, { debounceMs: 60_000 });

    const sent1 = notifier.notify(taskCompletedEvent('test', 'Task A', 'w1'));
    const sent2 = notifier.notify(taskCompletedEvent('test', 'Task B', 'w2'));
    expect(sent1).toBe(1);
    expect(sent2).toBe(0); // debounced
  });

  it('allows different event types without debounce', () => {
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://discord.com/api/webhooks/123/abc', events: ['task_completed', 'task_failed'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications, { debounceMs: 60_000 });

    notifier.notify(taskCompletedEvent('test', 'Task A', 'w1'));
    const sent = notifier.notify(taskFailedEvent('test', 'Task B', 'error'));
    expect(sent).toBe(1);
  });

  it('returns 0 when no webhooks configured', () => {
    const notifier = new WebhookNotifier(config);
    const sent = notifier.notify(taskCompletedEvent('test', 'x', 'w'));
    expect(sent).toBe(0);
  });

  // ── Discord payload format ──

  it('builds Discord embed payload', () => {
    const notifier = new WebhookNotifier(config);
    const event = taskCompletedEvent('proj', 'Auth', 'w1');
    const payload = notifier.buildPayload('discord', event) as any;

    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].title).toBe('✅ Task completed');
    expect(payload.embeds[0].description).toContain('Auth');
    expect(payload.embeds[0].color).toBe(0x2ecc71);
    expect(payload.embeds[0].footer.text).toContain('proj');
  });

  // ── Slack payload format ──

  it('builds Slack blocks payload', () => {
    const notifier = new WebhookNotifier(config);
    const event = escalationEvent('proj', 'Need help', 'w1');
    const payload = notifier.buildPayload('slack', event) as any;

    expect(payload.blocks).toBeDefined();
    expect(payload.blocks[0].type).toBe('header');
    expect(payload.blocks[1].text.text).toContain('Need help');
  });

  // ── Generic payload ──

  it('builds generic payload for unknown URLs', () => {
    const notifier = new WebhookNotifier(config);
    const event = taskCompletedEvent('proj', 'X', 'w');
    const payload = notifier.buildPayload('generic', event) as any;

    expect(payload.text).toContain('X');
    expect(payload.event).toBe('task_completed');
  });

  // ── Event builder helpers ──

  it('builds budget warning with fields', () => {
    const event = budgetWarningEvent('proj', 4.5, 5.0);
    expect(event.type).toBe('budget_warning');
    expect(event.fields).toHaveLength(2);
    expect(event.body).toContain('$4.50');
  });

  it('builds spec completed event', () => {
    const event = specCompletedEvent('proj', 'spec-1', 5, 0.42);
    expect(event.body).toContain('5 tasks');
    expect(event.body).toContain('$0.42');
  });

  it('builds daily report event', () => {
    const event = dailyReportEvent('proj', '# Report\n- done');
    expect(event.type).toBe('daily_report');
    expect(event.body).toContain('# Report');
  });

  it('builds agent stall event', () => {
    const event = agentStallEvent('proj', 'w1', 'Deploy');
    expect(event.body).toContain('w1');
    expect(event.body).toContain('Deploy');
  });

  // ── sendTest ──

  it('sendTest sends to all webhooks and reports results', async () => {
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://discord.com/api/webhooks/1/a', events: ['task_completed'] },
        { url: 'https://hooks.slack.com/services/x/y/z', events: ['escalation'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications);
    const result = await notifier.sendTest();
    expect(result.sent).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('sendTest reports errors on failure', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 403 });
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://discord.com/api/webhooks/1/a', events: ['task_completed'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications);
    const result = await notifier.sendTest();
    expect(result.sent).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('403');
  });

  // ── Auto-detect platform from URL ──

  it('auto-detects Discord from URL and sends embed', () => {
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://discord.com/api/webhooks/123/abc', events: ['task_completed'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications, { debounceMs: 0 });
    notifier.notify(taskCompletedEvent('test', 'X', 'w'));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.embeds).toBeDefined();
  });

  it('auto-detects Slack from URL and sends blocks', () => {
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://hooks.slack.com/services/x/y/z', events: ['escalation'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications, { debounceMs: 0 });
    notifier.notify(escalationEvent('test', 'help'));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.blocks).toBeDefined();
  });

  // ── New event types: agent_message and lead_response ──

  it('fires agent_message webhook for DMs', () => {
    
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://example.com/hook', events: ['agent_message'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications, { debounceMs: 0 });
    const event = agentMessageEvent('test-project', 'worker-1', 'lead-1', 'Task done!');
    const sent = notifier.notify(event);
    expect(sent).toBe(1);
    expect(event.type).toBe('agent_message');
    expect(event.body).toBe('Task done!');
    expect(event.fields).toContainEqual({ name: 'From', value: 'worker-1', inline: true });
    expect(event.fields).toContainEqual({ name: 'To', value: 'lead-1', inline: true });
  });

  it('fires agent_message webhook with channel for channel messages', () => {
    
    const event = agentMessageEvent('proj', 'lead-1', '', 'Hey team!', 'general');
    expect(event.fields).toContainEqual({ name: 'To', value: '#general', inline: true });
  });

  it('fires lead_response webhook', () => {
    
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://example.com/hook', events: ['lead_response'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications, { debounceMs: 0 });
    const event = leadResponseEvent('test-project', 'Here is my analysis...', 'What is the status?');
    const sent = notifier.notify(event);
    expect(sent).toBe(1);
    expect(event.type).toBe('lead_response');
    expect(event.body).toBe('Here is my analysis...');
    expect(event.fields).toContainEqual({ name: 'In reply to', value: 'What is the status?' });
  });

  it('lead_response without inReplyTo has no fields', () => {
    
    const event = leadResponseEvent('proj', 'Autonomous update');
    expect(event.fields).toBeUndefined();
  });

  it('does not fire agent_message when not subscribed', () => {
    
    const notifications: NotificationsConfig = {
      webhooks: [
        { url: 'https://example.com/hook', events: ['task_completed'] },
      ],
    };
    const notifier = new WebhookNotifier(config, notifications, { debounceMs: 0 });
    const sent = notifier.notify(agentMessageEvent('proj', 'w', 'l', 'hi'));
    expect(sent).toBe(0);
  });
});
