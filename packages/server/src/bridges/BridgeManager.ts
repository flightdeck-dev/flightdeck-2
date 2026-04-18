/**
 * BridgeManager — manages all chat bridges and routes messages between
 * external platforms and Flightdeck projects.
 */
import type { ChatBridge, BridgeConfig, BridgeMessage } from './types.js';

export class BridgeManager {
  private bridges = new Map<string, ChatBridge>();

  constructor(
    private config: BridgeConfig,
    private onMessage: (
      bridge: string,
      msg: BridgeMessage,
      projectName: string,
    ) => void,
  ) {}

  async startAll(): Promise<void> {
    // Discord
    if (this.config.discord?.enabled && this.config.discord.token) {
      try {
        const { DiscordBridge } = await import('./DiscordBridge.js');
        const bridge = new DiscordBridge(
          this.config.discord.token,
          this.config.discord.guildId,
          this.config.discord.channelMap,
        );
        const channelMap = this.config.discord.channelMap;
        bridge.onMessage = (msg) => {
          const projectName = Object.entries(channelMap ?? {}).find(
            ([, chId]) => chId === msg.channelId,
          )?.[0];
          if (projectName) {
            this.onMessage('discord', msg, projectName);
          }
        };
        await bridge.connect();
        this.bridges.set('discord', bridge);
        console.error('[bridges] Discord bridge connected');
      } catch (err: any) {
        console.error(
          `[bridges] Failed to start Discord bridge: ${err.message}`,
        );
      }
    }

    // Telegram
    if (this.config.telegram?.enabled && this.config.telegram.token) {
      try {
        const { TelegramBridge } = await import('./TelegramBridge.js');
        const bridge = new TelegramBridge(
          this.config.telegram.token,
          this.config.telegram.chatMap,
        );
        const chatMap = this.config.telegram.chatMap;
        bridge.onMessage = (msg) => {
          const projectName = Object.entries(chatMap ?? {}).find(
            ([, chId]) => chId === msg.channelId,
          )?.[0];
          if (projectName) {
            this.onMessage('telegram', msg, projectName);
          }
        };
        await bridge.connect();
        this.bridges.set('telegram', bridge);
        console.error('[bridges] Telegram bridge connected');
      } catch (err: any) {
        console.error(
          `[bridges] Failed to start Telegram bridge: ${err.message}`,
        );
      }
    }

    // Signal
    if (this.config.signal?.enabled && this.config.signal.phoneNumber) {
      try {
        const { SignalBridge } = await import('./SignalBridge.js');
        const bridge = new SignalBridge(
          this.config.signal.phoneNumber,
          this.config.signal.apiUrl ?? 'http://localhost:8080',
          this.config.signal.chatMap,
        );
        const chatMap = this.config.signal.chatMap;
        bridge.onMessage = (msg) => {
          const projectName = Object.entries(chatMap ?? {}).find(
            ([, chId]) => chId === msg.channelId,
          )?.[0];
          if (projectName) {
            this.onMessage('signal', msg, projectName);
          }
        };
        await bridge.connect();
        this.bridges.set('signal', bridge);
        console.error('[bridges] Signal bridge connected');
      } catch (err: any) {
        console.error(
          `[bridges] Failed to start Signal bridge: ${err.message}`,
        );
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, bridge] of this.bridges) {
      try {
        await bridge.disconnect();
        console.error(`[bridges] ${name} bridge disconnected`);
      } catch {
        /* best effort */
      }
    }
    this.bridges.clear();
  }

  async sendToChannel(
    bridgeName: string,
    channelId: string,
    text: string,
  ): Promise<void> {
    const bridge = this.bridges.get(bridgeName);
    if (!bridge) return;
    await bridge.sendMessage(channelId, text);
  }

  getBridge(name: string): ChatBridge | undefined {
    return this.bridges.get(name);
  }
}
