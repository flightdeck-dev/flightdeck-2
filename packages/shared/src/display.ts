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
  if (obj.toolOverrides !== undefined) {
    if (typeof obj.toolOverrides !== 'object' || obj.toolOverrides === null || Array.isArray(obj.toolOverrides)) return false;
    for (const val of Object.values(obj.toolOverrides as Record<string, unknown>)) {
      if (val !== null && !isValidToolVisibility(val)) return false;
    }
  }
  return true;
}
