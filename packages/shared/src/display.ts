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
  /** Per-tool overrides (tool name → visibility) */
  toolOverrides?: Record<string, ToolVisibility>;
}

/** Named presets for common display configurations */
export const DISPLAY_PRESETS = {
  minimal: {
    thinking: false,
    toolCalls: 'off' as const,
    flightdeckTools: 'off' as const,
  },
  summary: {
    thinking: false,
    toolCalls: 'summary' as const,
    flightdeckTools: 'off' as const,
  },
  detail: {
    thinking: true,
    toolCalls: 'detail' as const,
    flightdeckTools: 'summary' as const,
  },
  debug: {
    thinking: true,
    toolCalls: 'detail' as const,
    flightdeckTools: 'detail' as const,
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
): ToolVisibility | boolean {
  // Per-tool override takes precedence
  if (toolName && config.toolOverrides?.[toolName] !== undefined) {
    return config.toolOverrides[toolName];
  }

  switch (contentType) {
    case 'text':
      return 'detail'; // always show text
    case 'thinking':
      return config.thinking;
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
  const vis = getVisibility(config, contentType, toolName);
  if (typeof vis === 'boolean') return vis;
  return vis !== 'off';
}

/** Validate and merge a partial config into a full DisplayConfig */
export function mergeDisplayConfig(
  base: DisplayConfig,
  partial: Partial<DisplayConfig>,
): DisplayConfig {
  return {
    thinking: partial.thinking ?? base.thinking,
    toolCalls: partial.toolCalls ?? base.toolCalls,
    flightdeckTools: partial.flightdeckTools ?? base.flightdeckTools,
    toolOverrides: partial.toolOverrides !== undefined
      ? { ...base.toolOverrides, ...partial.toolOverrides }
      : base.toolOverrides,
  };
}

/** Validate that a value is a valid ToolVisibility */
export function isValidToolVisibility(v: unknown): v is ToolVisibility {
  return v === 'off' || v === 'summary' || v === 'detail';
}

/** Validate a DisplayConfig object */
export function isValidDisplayConfig(v: unknown): v is Partial<DisplayConfig> {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (obj.thinking !== undefined && typeof obj.thinking !== 'boolean') return false;
  if (obj.toolCalls !== undefined && !isValidToolVisibility(obj.toolCalls)) return false;
  if (obj.flightdeckTools !== undefined && !isValidToolVisibility(obj.flightdeckTools)) return false;
  if (obj.toolOverrides !== undefined) {
    if (typeof obj.toolOverrides !== 'object' || obj.toolOverrides === null) return false;
    for (const val of Object.values(obj.toolOverrides as Record<string, unknown>)) {
      if (!isValidToolVisibility(val)) return false;
    }
  }
  return true;
}
