/**
 * WebhookNotifier — fire-and-forget Discord/Slack webhook notifications.
 *
 * Auto-detects platform from URL:
 *   - discord.com/api/webhooks → Discord embed format
 *   - hooks.slack.com          → Slack blocks format
 *   - everything else          → plain JSON { text }
 *
 * Debounce: max 1 webhook per (event type × webhook URL) per 60 s.
 * Rate limit: respects Discord's 30 req/min global limit.
 */

import type { ProjectConfig } from '@flightdeck-ai/shared';

// ── Event types ──

export const WEBHOOK_EVENT_TYPES = [
  'task_completed',
  'task_failed',
  'spec_completed',
  'escalation',
  'daily_report',
  'agent_stall',
  'budget_warning',
] as const;
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

export interface WebhookEvent {
  type: WebhookEventType;
  project: string;
  title: string;
  body: string;
  /** Optional extra fields for structured embeds */
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  color?: number; // Discord embed color
  timestamp?: string; // ISO
}

// ── Config ──

export interface WebhookConfig {
  url: string;
  events: WebhookEventType[];
}

export interface NotificationsConfig {
  webhooks?: WebhookConfig[];
}

// ── Platform detection ──

type Platform = 'discord' | 'slack' | 'generic';

function detectPlatform(url: string): Platform {
  if (url.includes('discord.com/api/webhooks')) return 'discord';
  if (url.includes('hooks.slack.com')) return 'slack';
  return 'generic';
}

// ── Color map ──

const EVENT_COLORS: Record<WebhookEventType, number> = {
  task_completed: 0x2ecc71, // green
  task_failed: 0xe74c3c,    // red
  spec_completed: 0xf1c40f, // gold
  escalation: 0xe67e22,     // orange
  daily_report: 0x3498db,   // blue
  agent_stall: 0x95a5a6,    // grey
  budget_warning: 0xe74c3c, // red
};

// ── Payload builders ──

function buildDiscordPayload(event: WebhookEvent): object {
  const embed: Record<string, unknown> = {
    title: event.title,
    description: event.body.slice(0, 4096),
    color: event.color ?? EVENT_COLORS[event.type] ?? 0x7289da,
    timestamp: event.timestamp ?? new Date().toISOString(),
    footer: { text: `Flightdeck · ${event.project}` },
  };
  if (event.fields?.length) {
    embed.fields = event.fields.map(f => ({
      name: f.name,
      value: f.value.slice(0, 1024),
      inline: f.inline ?? false,
    }));
  }
  return { embeds: [embed] };
}

function buildSlackPayload(event: WebhookEvent): object {
  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: event.title.slice(0, 150), emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: event.body.slice(0, 3000) },
    },
  ];

  if (event.fields?.length) {
    blocks.push({
      type: 'section',
      fields: event.fields.slice(0, 10).map(f => ({
        type: 'mrkdwn',
        text: `*${f.name}*\n${f.value}`,
      })),
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Flightdeck · ${event.project}` }],
  });

  return { blocks };
}

function buildGenericPayload(event: WebhookEvent): object {
  return { text: `${event.title}\n\n${event.body}`, event: event.type, project: event.project };
}

// ── WebhookNotifier ──

export class WebhookNotifier {
  private webhooks: WebhookConfig[];
  private projectName: string;

  /** Debounce: Map<"eventType:url" → lastSentMs> */
  private lastSent = new Map<string, number>();
  private debounceMs: number;

  /** Discord rate limit tracking */
  private discordSendTimes: number[] = [];
  private static DISCORD_MAX_PER_MIN = 30;

  constructor(
    config: ProjectConfig,
    notifications?: NotificationsConfig,
    opts?: { debounceMs?: number },
  ) {
    this.projectName = config.name;
    this.webhooks = notifications?.webhooks ?? [];
    this.debounceMs = opts?.debounceMs ?? 60_000;
  }

  /** Number of configured webhooks */
  get count(): number {
    return this.webhooks.length;
  }

  /** Update webhook config at runtime */
  setWebhooks(webhooks: WebhookConfig[]): void {
    this.webhooks = webhooks;
  }

  /**
   * Fire a webhook event (non-blocking).
   * Returns number of webhooks actually sent to.
   */
  notify(event: WebhookEvent): number {
    let sent = 0;
    for (const wh of this.webhooks) {
      if (!wh.events.includes(event.type)) continue;

      // Debounce
      const key = `${event.type}:${wh.url}`;
      const now = Date.now();
      const last = this.lastSent.get(key) ?? 0;
      if (now - last < this.debounceMs) continue;
      this.lastSent.set(key, now);

      // Discord rate limit check
      const platform = detectPlatform(wh.url);
      if (platform === 'discord' && !this.canSendDiscord()) continue;

      this.send(wh.url, platform, event);
      sent++;
    }
    return sent;
  }

  /**
   * Send a test message to all configured webhooks.
   */
  async sendTest(): Promise<{ sent: number; errors: string[] }> {
    const errors: string[] = [];
    let sent = 0;
    for (const wh of this.webhooks) {
      const platform = detectPlatform(wh.url);
      const event: WebhookEvent = {
        type: 'task_completed',
        project: this.projectName,
        title: '🧪 Flightdeck Webhook Test',
        body: `This is a test message from Flightdeck project "${this.projectName}". If you see this, webhooks are working!`,
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Events', value: wh.events.join(', '), inline: true },
        ],
      };
      try {
        const payload = this.buildPayload(platform, event);
        const res = await fetch(wh.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          errors.push(`${wh.url}: HTTP ${res.status}`);
        } else {
          sent++;
        }
      } catch (err: any) {
        errors.push(`${wh.url}: ${err.message ?? err}`);
      }
    }
    return { sent, errors };
  }

  // ── Helpers (exported for testing) ──

  buildPayload(platform: Platform, event: WebhookEvent): object {
    switch (platform) {
      case 'discord': return buildDiscordPayload(event);
      case 'slack': return buildSlackPayload(event);
      default: return buildGenericPayload(event);
    }
  }

  /** Fire-and-forget send */
  private send(url: string, platform: Platform, event: WebhookEvent): void {
    const payload = this.buildPayload(platform, event);
    if (platform === 'discord') this.recordDiscordSend();

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(err => {
      // Log but don't crash
      console.error(`[WebhookNotifier] Failed to send to ${url}: ${err.message ?? err}`);
    });
  }

  private canSendDiscord(): boolean {
    const now = Date.now();
    this.discordSendTimes = this.discordSendTimes.filter(t => now - t < 60_000);
    return this.discordSendTimes.length < WebhookNotifier.DISCORD_MAX_PER_MIN;
  }

  private recordDiscordSend(): void {
    this.discordSendTimes.push(Date.now());
  }
}

// ── Convenience: build events from orchestrator context ──

export function taskCompletedEvent(project: string, taskTitle: string, agentId: string): WebhookEvent {
  return {
    type: 'task_completed',
    project,
    title: `✅ Task completed`,
    body: `Task "${taskTitle}" completed by ${agentId}`,
  };
}

export function taskFailedEvent(project: string, taskTitle: string, reason: string): WebhookEvent {
  return {
    type: 'task_failed',
    project,
    title: `❌ Task failed`,
    body: `Task "${taskTitle}" failed: ${reason}`,
  };
}

export function specCompletedEvent(project: string, specId: string, taskCount: number, cost?: number): WebhookEvent {
  const costStr = cost != null ? `, $${cost.toFixed(2)}` : '';
  return {
    type: 'spec_completed',
    project,
    title: `🎉 Spec completed`,
    body: `Spec "${specId}" completed (${taskCount} tasks${costStr})`,
  };
}

export function escalationEvent(project: string, message: string, agentId?: string): WebhookEvent {
  return {
    type: 'escalation',
    project,
    title: `⚠️ Escalation`,
    body: agentId ? `Worker ${agentId}: ${message}` : message,
  };
}

export function dailyReportEvent(project: string, reportMarkdown: string): WebhookEvent {
  return {
    type: 'daily_report',
    project,
    title: `📊 Daily Report`,
    body: reportMarkdown,
  };
}

export function agentStallEvent(project: string, agentId: string, taskTitle: string): WebhookEvent {
  return {
    type: 'agent_stall',
    project,
    title: `🔄 Agent stalled`,
    body: `Agent ${agentId} stalled on task "${taskTitle}", restarting`,
  };
}

export function budgetWarningEvent(project: string, current: number, limit: number): WebhookEvent {
  return {
    type: 'budget_warning',
    project,
    title: `💰 Budget warning`,
    body: `Project cost reached $${current.toFixed(2)} (limit: $${limit.toFixed(2)})`,
    fields: [
      { name: 'Current', value: `$${current.toFixed(2)}`, inline: true },
      { name: 'Limit', value: `$${limit.toFixed(2)}`, inline: true },
    ],
  };
}
