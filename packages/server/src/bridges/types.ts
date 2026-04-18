/**
 * Chat Bridge types for Flightdeck 2.0
 * Bridges connect external chat platforms (Discord, Telegram, Signal) to Flightdeck projects.
 */

export interface ChatBridge {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(channelId: string, text: string, attachments?: Array<{ url: string; filename: string }>): Promise<void>;
  onMessage: ((msg: BridgeMessage) => void) | null;
}

export interface BridgeMessage {
  channelId: string;
  userId: string;
  userName: string;
  text: string;
  messageId?: string;
  replyToId?: string;
  attachments?: Array<{ url: string; filename: string; mimeType: string }>;
}

export interface BridgeConfig {
  discord?: {
    enabled: boolean;
    token: string;
    guildId?: string;
    channelMap?: Record<string, string>;
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
