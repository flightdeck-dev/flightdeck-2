/**
 * Telegram Bridge — Phase 1: inline keyboards for plan approval,
 * MarkdownV2 formatting, attachment support.
 * Uses node-telegram-bot-api via dynamic import.
 */
import type { ChatBridge, BridgeMessage, SendMessageOptions } from './types.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Escape special characters for Telegram MarkdownV2 */
function escapeMarkdownV2(text: string): string {
  // Characters that must be escaped in MarkdownV2
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Convert basic markdown to MarkdownV2-safe text.
 * Preserves code blocks and inline code, escapes the rest. */
function toMarkdownV2(text: string): string {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Find the next code block or inline code
    const codeBlockMatch = remaining.match(/^([\s\S]*?)(```[\s\S]*?```|`[^`]+`)/);
    if (codeBlockMatch) {
      // Escape the text before the code
      if (codeBlockMatch[1]) {
        parts.push(escapeMarkdownV2(codeBlockMatch[1]));
      }
      // Keep code as-is (Telegram handles it)
      parts.push(codeBlockMatch[2]);
      remaining = remaining.slice(codeBlockMatch[0].length);
    } else {
      // No more code blocks, escape the rest
      parts.push(escapeMarkdownV2(remaining));
      break;
    }
  }
  return parts.join('');
}

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

    // Handle regular messages
    this.bot.on('message', (msg: any) => {
      const text = msg.text || msg.caption || '';
      const attachments: BridgeMessage['attachments'] = [];

      // Collect photo attachments (take largest resolution)
      if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        attachments.push({
          url: largest.file_id,
          filename: `photo_${largest.file_id}.jpg`,
          mimeType: 'image/jpeg',
        });
      }

      // Collect document attachments
      if (msg.document) {
        attachments.push({
          url: msg.document.file_id,
          filename: msg.document.file_name ?? 'document',
          mimeType: msg.document.mime_type ?? 'application/octet-stream',
        });
      }

      // Collect audio attachments
      if (msg.audio) {
        attachments.push({
          url: msg.audio.file_id,
          filename: msg.audio.file_name ?? 'audio.mp3',
          mimeType: msg.audio.mime_type ?? 'audio/mpeg',
        });
      }

      // Collect voice messages
      if (msg.voice) {
        attachments.push({
          url: msg.voice.file_id,
          filename: 'voice.ogg',
          mimeType: msg.voice.mime_type ?? 'audio/ogg',
        });
      }

      if (!text && attachments.length === 0) return;

      this.onMessage?.({
        channelId: String(msg.chat.id),
        userId: String(msg.from?.id ?? ''),
        userName: msg.from?.first_name ?? 'Unknown',
        text,
        messageId: String(msg.message_id),
        replyToId: msg.reply_to_message
          ? String(msg.reply_to_message.message_id)
          : undefined,
        attachments,
      });
    });

    // Handle inline keyboard callback queries
    this.bot.on('callback_query', (query: any) => {
      this.onMessage?.({
        channelId: String(query.message?.chat?.id ?? ''),
        userId: String(query.from?.id ?? ''),
        userName: query.from?.first_name ?? 'Unknown',
        text: '',
        messageId: String(query.message?.message_id ?? ''),
        callbackData: query.data,
        callbackQueryId: String(query.id),
      });

      // Acknowledge the callback
      this.bot.answerCallbackQuery(query.id).catch(() => {});
    });
  }

  async sendMessage(channelId: string, text: string, options?: SendMessageOptions): Promise<void> {
    if (!this.bot) return;
    const chatId = Number(channelId);

    // Handle file attachments (outgoing)
    if (options?.attachments && options.attachments.length > 0) {
      for (const att of options.attachments) {
        const ext = att.filename.split('.').pop()?.toLowerCase() ?? '';
        try {
          if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
            await this.bot.sendPhoto(chatId, att.url, { caption: text ? toMarkdownV2(text) : undefined, parse_mode: 'MarkdownV2' });
          } else if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) {
            await this.bot.sendAudio(chatId, att.url, { caption: text ? toMarkdownV2(text) : undefined, parse_mode: 'MarkdownV2' });
          } else {
            await this.bot.sendDocument(chatId, att.url, { caption: text ? toMarkdownV2(text) : undefined, parse_mode: 'MarkdownV2' });
          }
        } catch {
          // Fallback: send as document
          try { await this.bot.sendDocument(chatId, att.url); } catch { /* skip */ }
        }
      }
      // If text was sent as caption, we're done
      if (text && options.attachments.length > 0) return;
    }

    if (!text) return;

    // Build send options
    const sendOpts: any = {
      parse_mode: 'MarkdownV2',
    };

    // Inline keyboard for plan approval
    if (options?.inlineKeyboard) {
      sendOpts.reply_markup = {
        inline_keyboard: options.inlineKeyboard,
      };
    }

    try {
      await this.bot.sendMessage(chatId, toMarkdownV2(text), sendOpts);
    } catch {
      // Fallback: send without MarkdownV2 if escaping fails
      try {
        await this.bot.sendMessage(chatId, text, {
          ...(options?.inlineKeyboard ? { reply_markup: { inline_keyboard: options.inlineKeyboard } } : {}),
        });
      } catch { /* give up */ }
    }
  }

  /** Download a Telegram file to the uploads directory */
  async downloadAttachment(fileId: string, filename: string, uploadsDir: string): Promise<string> {
    if (!this.bot) throw new Error('Bot not connected');
    await mkdir(uploadsDir, { recursive: true });
    const filePath = join(uploadsDir, filename);
    // node-telegram-bot-api can download files
    await this.bot.downloadFile(fileId, uploadsDir);
    return filePath;
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }
  }
}
