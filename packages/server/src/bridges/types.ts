/**
 * Chat Bridge types for Flightdeck 2.0
 * Bridges connect external chat platforms (Discord, Telegram, Signal) to Flightdeck projects.
 */

export interface ChatBridge {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(channelId: string, text: string, options?: SendMessageOptions): Promise<void>;
  onMessage: ((msg: BridgeMessage) => void) | null;
}

export interface SendMessageOptions {
  /** Files to attach to the message */
  attachments?: Array<{ url: string; filename: string }>;
  /** For Discord: send as embed with colored sidebar */
  embed?: { title?: string; color?: number; fields?: Array<{ name: string; value: string; inline?: boolean }> };
  /** For Discord streaming: 'start' creates a placeholder, 'update' edits it, 'end' finalizes */
  streamPhase?: 'start' | 'update' | 'end';
  /** Message ID to edit (for streaming updates) */
  editMessageId?: string;
  /** For Telegram: inline keyboard buttons */
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>;
  /** Thread/reply target */
  threadId?: string;
}

export interface BridgeMessage {
  channelId: string;
  userId: string;
  userName: string;
  text: string;
  messageId?: string;
  replyToId?: string;
  threadId?: string;
  attachments?: Array<{ url: string; filename: string; mimeType: string }>;
  /** For Telegram callback queries (inline keyboard responses) */
  callbackData?: string;
  callbackQueryId?: string;
}

export interface BridgeConfig {
  discord?: {
    enabled: boolean;
    token: string;
    guildId?: string;
    channelMap?: Record<string, string>;
    streamMode?: 'off' | 'partial' | 'block';
    autoThread?: boolean;
    requireMention?: boolean;
    slashCommands?: boolean;
  };
  telegram?: {
    enabled: boolean;
    token: string;
    chatMap?: Record<string, string>;
  };
  signal?: {
    enabled: boolean;
    phoneNumber: string;
    apiUrl?: string;
    chatMap?: Record<string, string>;
  };
}
