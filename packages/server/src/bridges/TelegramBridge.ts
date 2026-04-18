/**
 * Telegram Bridge — uses node-telegram-bot-api via dynamic import.
 */
import type { ChatBridge, BridgeMessage } from './types.js';

export class TelegramBridge implements ChatBridge {
  name = 'telegram';
  private bot: any = null;
  onMessage: ((msg: BridgeMessage) => void) | null = null;

  constructor(
    private token: string,
    private chatMap?: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    const TelegramBot = ((await import('node-telegram-bot-api' as string)) as any).default;
    this.bot = new TelegramBot(this.token, { polling: true });

    this.bot.on('message', (msg: any) => {
      if (!msg.text) return;
      this.onMessage?.({
        channelId: String(msg.chat.id),
        userId: String(msg.from?.id ?? ''),
        userName: msg.from?.first_name ?? 'Unknown',
        text: msg.text,
        messageId: String(msg.message_id),
        replyToId: msg.reply_to_message
          ? String(msg.reply_to_message.message_id)
          : undefined,
      });
    });
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendMessage(Number(channelId), text, {
      parse_mode: 'Markdown',
    });
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }
  }
}
