import { appendFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { writeJsonAtomicSync } from '../infra/json-files.js';
import { join } from 'node:path';
import type { Message, AgentId } from '@flightdeck-ai/shared';

export class MessageLog {
  constructor(private messagesDir: string) {}

  append(message: Message, channel: string = 'general'): void {
    mkdirSync(this.messagesDir, { recursive: true });
    const filepath = join(this.messagesDir, `${channel}.jsonl`);
    appendFileSync(filepath, JSON.stringify(message) + '\n');
  }

  read(channel: string = 'general', since?: string): Message[] {
    const filepath = join(this.messagesDir, `${channel}.jsonl`);
    if (!existsSync(filepath)) return [];
    const lines = readFileSync(filepath, 'utf-8').trim().split('\n').filter(Boolean);
    let messages = lines.map(l => JSON.parse(l) as Message);
    if (since) {
      messages = messages.filter(m => m.timestamp > since);
    }
    return messages;
  }

  /**
   * Get unread DMs for a specific agent.
   * Reads the 'dm' channel and filters messages addressed to `agentId`
   * that arrived after the agent's last-read timestamp.
   */
  getUnreadDMs(agentId: AgentId): Message[] {
    const lastRead = this.getLastRead(agentId);
    const allDMs = this.read('dm');
    return allDMs.filter(m => m.to === agentId && (!lastRead || m.timestamp > lastRead));
  }

  /**
   * Mark all DMs up to now as read for an agent.
   * Stores the timestamp in a simple JSON file per messages dir.
   */
  markRead(agentId: AgentId): void {
    mkdirSync(this.messagesDir, { recursive: true });
    const state = this.readReadState();
    state[agentId] = new Date().toISOString();
    writeJsonAtomicSync(this.readStatePath(), state);
  }

  /** Get the last-read timestamp for an agent, or null if never read. */
  getLastRead(agentId: AgentId): string | null {
    const state = this.readReadState();
    return state[agentId] ?? null;
  }

  channels(): string[] {
    if (!existsSync(this.messagesDir)) return [];
    const files = readdirSync(this.messagesDir);
    return files
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => f.replace('.jsonl', ''));
  }

  private readStatePath(): string {
    return join(this.messagesDir, '_read-state.json');
  }

  private readReadState(): Record<string, string> {
    const filepath = this.readStatePath();
    if (!existsSync(filepath)) return {};
    try {
      return JSON.parse(readFileSync(filepath, 'utf-8'));
    } catch {
      return {};
    }
  }
}
