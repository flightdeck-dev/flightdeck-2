/**
 * Discord Bridge — uses discord.js via dynamic import to avoid build breakage.
 */
import type { ChatBridge, BridgeMessage } from './types.js';

export class DiscordBridge implements ChatBridge {
  name = 'discord';
  private client: any = null;
  onMessage: ((msg: BridgeMessage) => void) | null = null;

  constructor(
    private token: string,
    private guildId?: string,
    private channelMap?: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    const { Client, GatewayIntentBits } = await import('discord.js' as string) as any;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('messageCreate', (msg: any) => {
      if (msg.author.bot) return;

      const projectName = Object.entries(this.channelMap ?? {}).find(
        ([, chId]) => chId === msg.channelId,
      )?.[0];
      if (!projectName && this.channelMap) return;

      this.onMessage?.({
        channelId: msg.channelId,
        userId: msg.author.id,
        userName: msg.author.displayName ?? msg.author.username,
        text: msg.content,
        messageId: msg.id,
        replyToId: msg.reference?.messageId ?? undefined,
        attachments: msg.attachments.map((a: any) => ({
          url: a.url,
          filename: a.name ?? 'file',
          mimeType: a.contentType ?? 'application/octet-stream',
        })),
      });
    });

    await this.client.login(this.token);
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    if (!this.client) return;
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      const chunks = text.match(/.{1,1900}/gs) ?? [text];
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.client?.destroy();
    this.client = null;
  }
}
