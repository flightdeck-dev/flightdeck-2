/**
 * Display configuration for controlling UI visibility of thinking, tool calls, etc.
 */

export type ToolVisibility = 'off' | 'summary' | 'detail';

export interface DisplayConfig {
  /** Show agent thinking/reasoning process */
  thinking: boolean;
  /** Tool call visibility level */
  toolCalls: ToolVisibility;
  /** Flightdeck internal tool calls (flightdeck_* prefix) visibility */
  flightdeckTools: ToolVisibility;
  /**
   * Agent↔agent DM visibility in the main chat.
   * 'off' hides them, 'summary' collapses consecutive DMs into an expandable
   * one-liner (default), 'detail' shows full bubbles with sender → recipient.
   */
  agentMessages?: ToolVisibility;
  /**
   * System message visibility in the main chat (operational notices, forwarded
   * steers, scout/orchestrator chatter), used by `shouldShowSystemMessage` to
   * gate non-error system messages:
   * - 'off'     — hide notices and debug chatter
   * - 'summary' — show 'notice'-class messages
   * - 'detail'  — show 'notice' and 'debug'-class messages
   * NOTE: 'error'-class system messages are ALWAYS shown regardless of this
   * setting. How a visible message is laid out (pill vs collapsible) is a UI
   * concern decided by the renderer, not by this value.
   */
  systemMessages?: ToolVisibility;
  /** Per-tool overrides (tool name → visibility) */
  toolOverrides?: Record<string, ToolVisibility>;
}

/** Named presets for common display configurations */
export const DISPLAY_PRESETS = {
  minimal: {
    thinking: false,
    toolCalls: 'off' as const,
    flightdeckTools: 'off' as const,
    agentMessages: 'off' as const,
    systemMessages: 'off' as const,
  },
  summary: {
    thinking: false,
    toolCalls: 'summary' as const,
    flightdeckTools: 'off' as const,
    agentMessages: 'summary' as const,
    systemMessages: 'off' as const,
  },
  detail: {
    thinking: true,
    toolCalls: 'detail' as const,
    flightdeckTools: 'summary' as const,
    agentMessages: 'detail' as const,
    systemMessages: 'summary' as const,
  },
  debug: {
    thinking: true,
    toolCalls: 'detail' as const,
    flightdeckTools: 'detail' as const,
    agentMessages: 'detail' as const,
    systemMessages: 'detail' as const,
  },
} as const;

export type DisplayPreset = keyof typeof DISPLAY_PRESETS;
export const DISPLAY_PRESET_NAMES = Object.keys(DISPLAY_PRESETS) as DisplayPreset[];

/** Default display config */
export const DEFAULT_DISPLAY: DisplayConfig = { ...DISPLAY_PRESETS.summary };

/** Content type classification for stream events */
export type ContentType =
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'flightdeck_tool_call'
  | 'flightdeck_tool_result';

/** Check if a tool name is a Flightdeck internal tool */
export function isFlightdeckTool(toolName: string): boolean {
  return toolName.startsWith('flightdeck_');
}

/** Determine visibility for a given content type based on display config */
export function getVisibility(
  config: DisplayConfig,
  contentType: ContentType,
  toolName?: string,
): ToolVisibility {
  // Per-tool override takes precedence
  if (toolName && config.toolOverrides?.[toolName] !== undefined) {
    return config.toolOverrides[toolName];
  }

  switch (contentType) {
    case 'text':
      return 'detail'; // always show text
    case 'thinking':
      return config.thinking ? 'detail' : 'off';
    case 'tool_call':
    case 'tool_result':
      return config.toolCalls;
    case 'flightdeck_tool_call':
    case 'flightdeck_tool_result':
      return config.flightdeckTools;
  }
}

/** Returns true if the content should be shown at all */
export function shouldShow(
  config: DisplayConfig,
  contentType: ContentType,
  toolName?: string,
): boolean {
  return getVisibility(config, contentType, toolName) !== 'off';
}

/** Partial display config input that allows null in toolOverrides to delete keys */
export type PartialDisplayConfig = Partial<Omit<DisplayConfig, 'toolOverrides'>> & {
  toolOverrides?: Record<string, ToolVisibility | null>;
};

/** Validate and merge a partial config into a full DisplayConfig */
export function mergeDisplayConfig(
  base: DisplayConfig,
  partial: PartialDisplayConfig,
): DisplayConfig {
  let toolOverrides = base.toolOverrides;
  if (partial.toolOverrides !== undefined) {
    const merged = { ...base.toolOverrides, ...partial.toolOverrides };
    // Remove keys set to null
    for (const [key, val] of Object.entries(merged)) {
      if (val === null) delete merged[key];
    }
    toolOverrides = Object.keys(merged).length === 0 ? undefined : (merged as Record<string, ToolVisibility>);
  }
  return {
    thinking: partial.thinking ?? base.thinking,
    toolCalls: partial.toolCalls ?? base.toolCalls,
    flightdeckTools: partial.flightdeckTools ?? base.flightdeckTools,
    // Persisted configs may predate this field — default to collapsed
    agentMessages: partial.agentMessages ?? base.agentMessages ?? 'summary',
    // Persisted configs may predate this field — default to hidden
    systemMessages: partial.systemMessages ?? base.systemMessages ?? 'off',
    toolOverrides,
  };
}

/** Validate that a value is a valid ToolVisibility */
export function isValidToolVisibility(v: unknown): v is ToolVisibility {
  return v === 'off' || v === 'summary' || v === 'detail';
}

/** Validate a DisplayConfig object (accepts null values in toolOverrides for deletion) */
export function isValidDisplayConfig(v: unknown): v is PartialDisplayConfig {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (obj.thinking !== undefined && typeof obj.thinking !== 'boolean') return false;
  if (obj.toolCalls !== undefined && !isValidToolVisibility(obj.toolCalls)) return false;
  if (obj.flightdeckTools !== undefined && !isValidToolVisibility(obj.flightdeckTools)) return false;
  if (obj.agentMessages !== undefined && !isValidToolVisibility(obj.agentMessages)) return false;
  if (obj.systemMessages !== undefined && !isValidToolVisibility(obj.systemMessages)) return false;
  if (obj.toolOverrides !== undefined) {
    if (typeof obj.toolOverrides !== 'object' || obj.toolOverrides === null || Array.isArray(obj.toolOverrides)) return false;
    for (const val of Object.values(obj.toolOverrides as Record<string, unknown>)) {
      if (val !== null && !isValidToolVisibility(val)) return false;
    }
  }
  return true;
}

// ── System message classification ──

/**
 * Classification of a persisted `system` chat message, used to decide how it
 * renders and whether the `systemMessages` visibility setting applies.
 *
 * - `error`   — operational failures (spawn errors, stack traces). ALWAYS shown.
 * - `notice`  — short operational confirmations. Governed by `systemMessages`.
 * - `debug`   — noisy internals: forwarded steers (system DMs), scout/orchestrator
 *               chatter. Governed by `systemMessages` (only at 'detail').
 */
export type SystemMessageClass = 'error' | 'notice' | 'debug';

/** Minimal shape needed to classify a system message (subset of ChatMessage). */
export interface SystemMessageLike {
  content: string;
  authorId?: string | null;
  channel?: string | null;
  channelId?: string | null;
  recipient?: string | null;
}

const ERROR_PREFIXES = ['⚠️', '❌', '🛑'];
// Failure keywords. Matched across the WHOLE message (not just the first line)
// so a failure system message is never misclassified as notice/debug and then
// hidden — failures must always be shown.
const FAILURE_RE = /\b(failed|failure|error|exception|stack trace|panic|crashed?)\b/i;

/** Classify a `system`-authored chat message. */
export function classifySystemMessage(msg: SystemMessageLike): SystemMessageClass {
  const content = msg.content ?? '';
  const trimmed = content.trimStart();
  if (ERROR_PREFIXES.some(p => trimmed.startsWith(p)) || FAILURE_RE.test(content)) {
    return 'error';
  }
  // Forwarded steer copies are persisted as system DMs (recipient / dm channel).
  const isDm = !!(msg.recipient || msg.channel?.startsWith('dm:') || msg.channel === 'dm' || msg.channelId?.startsWith('dm:'));
  if (isDm) return 'debug';
  // Scout / orchestrator internal chatter.
  if (msg.authorId === 'orchestrator' || trimmed.startsWith('[scout]')) return 'debug';
  return 'notice';
}

/**
 * Decide whether a system message should be visible given its class and the
 * configured `systemMessages` visibility.
 * - error: always visible.
 * - notice: visible at 'summary' and 'detail'.
 * - debug: visible only at 'detail'.
 */
export function shouldShowSystemMessage(
  cls: SystemMessageClass,
  visibility: ToolVisibility | undefined,
): boolean {
  if (cls === 'error') return true;
  const v = visibility ?? 'off';
  if (v === 'off') return false;
  if (cls === 'notice') return v === 'summary' || v === 'detail';
  return v === 'detail'; // debug
}
