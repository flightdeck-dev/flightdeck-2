/**
 * Signal Bridge — Phase 1: attachment support (bidirectional).
 * Uses signal-cli REST API (no npm dependency).
 */
import type { ChatBridge, BridgeMessage, SendMessageOptions } from './types.js';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

export class SignalBridge implements ChatBridge {
  name = 'signal';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  onMessage: ((msg: BridgeMessage) => void) | null = null;

  constructor(
    private phoneNumber: string,
    private apiUrl: string = 'http://localhost:8080',
    private chatMap?: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    this.pollTimer = setInterval(async () => {
      try {
        const res = await fetch(
          `${this.apiUrl}/v1/receive/${encodeURIComponent(this.phoneNumber)}`,
        );
        const messages: any[] = await res.json();
        for (const msg of messages) {
          const dataMsg = msg.envelope?.dataMessage;
          if (!dataMsg) continue;

          const text = dataMsg.message ?? '';
          const attachments: BridgeMessage['attachments'] = [];

          // Process incoming attachments
          if (dataMsg.attachments && Array.isArray(dataMsg.attachments)) {
            for (const att of dataMsg.attachments) {
              attachments.push({
                url: att.id ?? '',
                filename: att.filename ?? `attachment_${att.id}`,
                mimeType: att.contentType ?? 'application/octet-stream',
              });
            }
          }

          if (!text && attachments.length === 0) continue;

          this.onMessage?.({
            channelId: msg.envelope.source ?? '',
            userId: msg.envelope.source ?? '',
            userName:
              msg.envelope.sourceName ?? msg.envelope.source ?? 'Unknown',
            text,
            messageId: String(msg.envelope.timestamp),
            attachments,
          });
        }
      } catch {
        /* poll failure — retry next interval */
      }
    }, 2000);
  }

  async sendMessage(channelId: string, text: string, options?: SendMessageOptions): Promise<void> {
    const body: any = {
      message: text,
      number: this.phoneNumber,
      recipients: [channelId],
    };

    // Handle outgoing attachments
    if (options?.attachments && options.attachments.length > 0) {
      const base64Attachments: string[] = [];
      for (const att of options.attachments) {
        try {
          // If it's a local file path, read and base64 encode
          const fileData = await readFile(att.url);
          base64Attachments.push(fileData.toString('base64'));
        } catch {
          // If it's a URL, fetch and base64 encode
          try {
            const res = await fetch(att.url);
            const buffer = Buffer.from(await res.arrayBuffer());
            base64Attachments.push(buffer.toString('base64'));
          } catch { /* skip failed attachment */ }
        }
      }
      if (base64Attachments.length > 0) {
        body.base64_attachments = base64Attachments;
      }
    }

    await fetch(`${this.apiUrl}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Download a Signal attachment to the uploads directory */
  async downloadAttachment(attachmentId: string, filename: string, uploadsDir: string): Promise<string> {
    await mkdir(uploadsDir, { recursive: true });
    const res = await fetch(
      `${this.apiUrl}/v1/attachments/${encodeURIComponent(attachmentId)}`,
    );
    const buffer = Buffer.from(await res.arrayBuffer());
    const filePath = join(uploadsDir, filename);
    await writeFile(filePath, buffer);
    return filePath;
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
