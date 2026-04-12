import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '../core/types.js';

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

  channels(): string[] {
    if (!existsSync(this.messagesDir)) return [];
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    return readdirSync(this.messagesDir)
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => f.replace('.jsonl', ''));
  }
}
