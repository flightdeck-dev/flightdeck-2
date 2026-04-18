/**
 * Signal Bridge — uses signal-cli REST API (no npm dependency).
 */
import type { ChatBridge, BridgeMessage } from './types.js';

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
          if (msg.envelope?.dataMessage?.message) {
            this.onMessage?.({
              channelId: msg.envelope.source ?? '',
              userId: msg.envelope.source ?? '',
              userName:
                msg.envelope.sourceName ?? msg.envelope.source ?? 'Unknown',
              text: msg.envelope.dataMessage.message,
              messageId: String(msg.envelope.timestamp),
            });
          }
        }
      } catch {
        /* poll failure — retry next interval */
      }
    }, 2000);
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    await fetch(`${this.apiUrl}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        number: this.phoneNumber,
        recipients: [channelId],
      }),
    });
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
