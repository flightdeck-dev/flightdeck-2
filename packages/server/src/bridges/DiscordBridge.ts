/**
 * Discord Bridge — Phase 1: streaming, auto-thread, slash commands,
 * mention gating, rich formatting, attachment support.
 * Uses discord.js via dynamic import to avoid build breakage.
 */
import type { ChatBridge, BridgeMessage, SendMessageOptions } from './types.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DISCORD_MAX_LENGTH = 2000;
const STREAM_UPDATE_INTERVAL = 1000; // ms

/** Split text into chunks that fit Discord's 2000 char limit */
function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitAt < DISCORD_MAX_LENGTH / 2) splitAt = DISCORD_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

export class DiscordBridge implements ChatBridge {
  name = 'discord';
  private client: any = null;
  private REST: any = null;
  private Routes: any = null;
  onMessage: ((msg: BridgeMessage) => void) | null = null;
  private streamMessages = new Map<string, { messageObj: any; lastUpdate: number }>();

  constructor(
    private token: string,
    private guildId?: string,
    private channelMap?: Record<string, string>,
    private streamMode: 'off' | 'partial' | 'block' = 'partial',
    private autoThread: boolean = false,
    private requireMention: boolean = true,
    private slashCommands: boolean = true,
  ) {}

  async connect(): Promise<void> {
    const djs = await import('discord.js' as string) as any;
    const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = djs;

    this.REST = REST;
    this.Routes = Routes;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    // Register slash commands
    if (this.slashCommands && this.guildId) {
      try {
        const rest = new REST({ version: '10' }).setToken(this.token);
        const commands = [
          new SlashCommandBuilder()
            .setName('fd')
            .setDescription('Flightdeck commands')
            .addSubcommand((sub: any) => sub.setName('status').setDescription('Project status'))
            .addSubcommand((sub: any) => sub.setName('agents').setDescription('List agents'))
            .addSubcommand((sub: any) => sub.setName('tasks').setDescription('Task summary'))
            .addSubcommand((sub: any) =>
              sub.setName('model')
                .setDescription('Change Lead model')
                .addStringOption((opt: any) => opt.setName('model').setDescription('Model name').setRequired(true))
            ),
        ].map((c: any) => c.toJSON());

        await rest.put(
          Routes.applicationGuildCommands(this.client.application?.id ?? (await this.getAppId(rest)), this.guildId),
          { body: commands },
        );
        console.error('[bridges/discord] Slash commands registered');
      } catch (err: any) {
        console.error(`[bridges/discord] Failed to register slash commands: ${err.message}`);
      }
    }

    // Handle slash command interactions
    this.client.on('interactionCreate', async (interaction: any) => {
      if (!interaction.isChatInputCommand?.()) return;
      if (interaction.commandName !== 'fd') return;

      const sub = interaction.options.getSubcommand();

      // Route as a special message with __slash__ prefix
      this.onMessage?.({
        channelId: interaction.channelId,
        userId: interaction.user.id,
        userName: interaction.user.displayName ?? interaction.user.username,
        text: `__slash__:${sub}${sub === 'model' ? ':' + interaction.options.getString('model') : ''}`,
        messageId: interaction.id,
      });

      // Defer reply — the BridgeManager will send the actual response
      await interaction.deferReply().catch(() => {});
    });

    // Handle messages
    this.client.on('messageCreate', (msg: any) => {
      if (msg.author.bot) return;

      const projectName = Object.entries(this.channelMap ?? {}).find(
        ([, chId]) => chId === msg.channelId,
      )?.[0];
      if (!projectName && this.channelMap) return;

      // Mention gating
      if (this.requireMention) {
        const isDM = !msg.guild;
        const isThread = msg.channel?.isThread?.();
        if (!isDM && !isThread) {
          const mentioned = msg.mentions.has(this.client.user);
          if (!mentioned) return;
        }
      }

      // Strip bot mention from text
      let text = msg.content;
      if (this.client.user) {
        text = text.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
      }

      // Download attachments info
      const attachments = msg.attachments.map((a: any) => ({
        url: a.url,
        filename: a.name ?? 'file',
        mimeType: a.contentType ?? 'application/octet-stream',
      }));

      const bridgeMsg: BridgeMessage = {
        channelId: msg.channelId,
        userId: msg.author.id,
        userName: msg.author.displayName ?? msg.author.username,
        text,
        messageId: msg.id,
        replyToId: msg.reference?.messageId ?? undefined,
        threadId: msg.channel?.isThread?.() ? msg.channelId : undefined,
        attachments,
      };

      // Auto-thread: create a thread for the conversation
      if (this.autoThread && msg.guild && !msg.channel?.isThread?.()) {
        const threadName = text.slice(0, 100) || 'Conversation';
        msg.startThread({ name: threadName, autoArchiveDuration: 1440 })
          .then((thread: any) => {
            bridgeMsg.threadId = thread.id;
            this.onMessage?.(bridgeMsg);
          })
          .catch(() => {
            this.onMessage?.(bridgeMsg);
          });
      } else {
        this.onMessage?.(bridgeMsg);
      }
    });

    await this.client.login(this.token);

    // Re-register slash commands after ready (need application id)
    this.client.once('ready', async () => {
      if (this.slashCommands && this.guildId && this.client.application?.id) {
        try {
          const djs2 = await import('discord.js' as string) as any;
          const rest = new djs2.REST({ version: '10' }).setToken(this.token);
          const { SlashCommandBuilder: SCB } = djs2;
          const commands = [
            new SCB()
              .setName('fd')
              .setDescription('Flightdeck commands')
              .addSubcommand((sub: any) => sub.setName('status').setDescription('Project status'))
              .addSubcommand((sub: any) => sub.setName('agents').setDescription('List agents'))
              .addSubcommand((sub: any) => sub.setName('tasks').setDescription('Task summary'))
              .addSubcommand((sub: any) =>
                sub.setName('model')
                  .setDescription('Change Lead model')
                  .addStringOption((opt: any) => opt.setName('model').setDescription('Model name').setRequired(true))
              ),
          ].map((c: any) => c.toJSON());

          await rest.put(
            djs2.Routes.applicationGuildCommands(this.client.application.id, this.guildId),
            { body: commands },
          );
          console.error('[bridges/discord] Slash commands registered (post-ready)');
        } catch (err: any) {
          console.error(`[bridges/discord] Slash command registration failed: ${err.message}`);
        }
      }
    });
  }

  private async getAppId(rest: any): Promise<string> {
    try {
      const app = await rest.get('/api/v10/oauth2/applications/@me');
      return (app as any).id;
    } catch {
      return '';
    }
  }

  async sendMessage(channelId: string, text: string, options?: SendMessageOptions): Promise<void> {
    if (!this.client) return;

    const targetChannelId = options?.threadId ?? channelId;
    const channel = await this.client.channels.fetch(targetChannelId);
    if (!channel?.isTextBased()) return;

    // Handle embed responses (for slash commands / rich formatting)
    if (options?.embed) {
      const djs = await import('discord.js' as string) as any;
      const embed = new djs.EmbedBuilder()
        .setColor(options.embed.color ?? 0x5865f2);
      if (options.embed.title) embed.setTitle(options.embed.title);
      if (options.embed.fields) {
        for (const f of options.embed.fields) {
          embed.addFields({ name: f.name, value: f.value.slice(0, 1024), inline: f.inline ?? false });
        }
      }
      if (text) embed.setDescription(text.slice(0, 4096));
      await channel.send({ embeds: [embed] });
      return;
    }

    // Handle streaming modes
    if (options?.streamPhase) {
      await this.handleStream(channel, channelId, text, options);
      return;
    }

    // Handle file attachments
    const files = options?.attachments?.map(a => ({ attachment: a.url, name: a.filename })) ?? [];

    // Split long messages
    const chunks = splitMessage(text);
    for (let i = 0; i < chunks.length; i++) {
      const payload: any = { content: chunks[i] };
      // Attach files only to the last chunk
      if (i === chunks.length - 1 && files.length > 0) {
        payload.files = files;
      }
      await channel.send(payload);
    }
  }

  private async handleStream(channel: any, channelId: string, text: string, options: SendMessageOptions): Promise<void> {
    const key = `${channelId}:stream`;

    if (options.streamPhase === 'start') {
      const content = this.streamMode === 'block' ? '💭 Lead is thinking...' : text || '...';
      const msg = await channel.send(content);
      this.streamMessages.set(key, { messageObj: msg, lastUpdate: Date.now() });
      return;
    }

    if (options.streamPhase === 'update') {
      const entry = this.streamMessages.get(key);
      if (!entry) return;
      if (this.streamMode === 'block') return; // Don't update in block mode
      const now = Date.now();
      if (now - entry.lastUpdate < STREAM_UPDATE_INTERVAL) return;
      try {
        // Discord limits edits to 2000 chars
        const truncated = text.length > DISCORD_MAX_LENGTH
          ? text.slice(text.length - DISCORD_MAX_LENGTH + 3) + '...'
          : text;
        await entry.messageObj.edit(truncated);
        entry.lastUpdate = now;
      } catch { /* edit may fail if message was deleted */ }
      return;
    }

    if (options.streamPhase === 'end') {
      const entry = this.streamMessages.get(key);
      this.streamMessages.delete(key);
      if (entry) {
        try {
          if (text.length <= DISCORD_MAX_LENGTH) {
            await entry.messageObj.edit(text);
          } else {
            // Delete placeholder, send as multiple messages
            await entry.messageObj.delete().catch(() => {});
            const chunks = splitMessage(text);
            for (const chunk of chunks) {
              await channel.send(chunk);
            }
          }
        } catch {
          // Fallback: just send as new message
          const chunks = splitMessage(text);
          for (const chunk of chunks) {
            await channel.send(chunk);
          }
        }
      } else {
        // No stream entry, just send
        const chunks = splitMessage(text);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
      return;
    }
  }

  /** Download a Discord attachment to the project uploads directory */
  async downloadAttachment(url: string, filename: string, uploadsDir: string): Promise<string> {
    await mkdir(uploadsDir, { recursive: true });
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    const filePath = join(uploadsDir, filename);
    await writeFile(filePath, buffer);
    return filePath;
  }

  async disconnect(): Promise<void> {
    this.streamMessages.clear();
    this.client?.destroy();
    this.client = null;
  }
}
