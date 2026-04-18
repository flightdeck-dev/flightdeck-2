import { z } from 'zod';

export const ProjectConfigSchema = z.object({
  name: z.string(),
  governance: z.enum(['autonomous', 'supervised', 'collaborative', 'custom']),
  isolation: z.enum(['file_lock', 'git_worktree']),
  onCompletion: z.enum(['stop', 'ask', 'explore']),
  heartbeatEnabled: z.boolean().default(false),
  timezone: z.string().default("UTC"),
  heartbeatIdleTimeoutDays: z.number().min(0).max(30).default(3),
  scoutEnabled: z.boolean().default(false),
  maxConcurrentWorkers: z.number().min(1).max(100).default(30),
  planApprovalThreshold: z.number().min(1).default(3),
  costThresholdPerDay: z.number().optional(),
  cwd: z.string().optional(),
  notifications: z.object({
    webhooks: z.array(z.object({
      url: z.string(),
      events: z.array(z.string()),
    })),
  }).optional(),
});

const BridgeDiscordSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(''),
  guildId: z.string().optional(),
  channelMap: z.record(z.string()).optional(),
  streamMode: z.enum(['off', 'partial', 'block']).default('partial'),
  autoThread: z.boolean().default(false),
  requireMention: z.boolean().default(true),
  slashCommands: z.boolean().default(true),
});

const BridgeTelegramSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(''),
  chatMap: z.record(z.string()).optional(),
});

const BridgeSignalSchema = z.object({
  enabled: z.boolean().default(false),
  phoneNumber: z.string().default(''),
  apiUrl: z.string().optional(),
  chatMap: z.record(z.string()).optional(),
});

const BridgesSchema = z.object({
  discord: BridgeDiscordSchema.optional(),
  telegram: BridgeTelegramSchema.optional(),
  signal: BridgeSignalSchema.optional(),
});

export const GlobalConfigSchema = z.object({
  disabledRuntimes: z.array(z.string()).default([]),
  runtimeOrder: z.array(z.string()).default([]),
  bridges: BridgesSchema.optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
