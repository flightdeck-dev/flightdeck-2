import { z } from 'zod';

export const ProjectConfigSchema = z.object({
  name: z.string(),
  governance: z.enum(['autonomous', 'supervised', 'collaborative', 'custom']),
  isolation: z.enum(['file_lock', 'git_worktree']),
  onCompletion: z.enum(['stop', 'ask', 'explore']),
  heartbeatEnabled: z.boolean().default(false),
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

export const GlobalConfigSchema = z.object({
  disabledRuntimes: z.array(z.string()).default([]),
  runtimeOrder: z.array(z.string()).default([]),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
