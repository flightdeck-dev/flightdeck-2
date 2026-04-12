import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DISPLAY,
  DISPLAY_PRESETS,
  DISPLAY_PRESET_NAMES,
  isFlightdeckTool,
  shouldShow,
  getVisibility,
  mergeDisplayConfig,
  isValidDisplayConfig,
  isValidToolVisibility,
  type DisplayConfig,
} from '@flightdeck-ai/shared';

describe('DisplayConfig', () => {
  describe('defaults', () => {
    it('DEFAULT_DISPLAY matches summary preset', () => {
      expect(DEFAULT_DISPLAY.thinking).toBe(false);
      expect(DEFAULT_DISPLAY.toolCalls).toBe('summary');
      expect(DEFAULT_DISPLAY.flightdeckTools).toBe('off');
    });

    it('DISPLAY_PRESET_NAMES has all presets', () => {
      expect(DISPLAY_PRESET_NAMES).toEqual(['minimal', 'summary', 'detail', 'debug']);
    });
  });

  describe('presets', () => {
    it('minimal hides everything', () => {
      const p = DISPLAY_PRESETS.minimal;
      expect(p.thinking).toBe(false);
      expect(p.toolCalls).toBe('off');
      expect(p.flightdeckTools).toBe('off');
    });

    it('debug shows everything', () => {
      const p = DISPLAY_PRESETS.debug;
      expect(p.thinking).toBe(true);
      expect(p.toolCalls).toBe('detail');
      expect(p.flightdeckTools).toBe('detail');
    });

    it('detail shows thinking and tools but flightdeck at summary', () => {
      const p = DISPLAY_PRESETS.detail;
      expect(p.thinking).toBe(true);
      expect(p.toolCalls).toBe('detail');
      expect(p.flightdeckTools).toBe('summary');
    });
  });

  describe('isFlightdeckTool', () => {
    it('identifies flightdeck_ prefixed tools', () => {
      expect(isFlightdeckTool('flightdeck_task_list')).toBe(true);
      expect(isFlightdeckTool('flightdeck_status')).toBe(true);
      expect(isFlightdeckTool('shell')).toBe(false);
      expect(isFlightdeckTool('write_file')).toBe(false);
    });
  });

  describe('shouldShow', () => {
    it('always shows text', () => {
      expect(shouldShow(DISPLAY_PRESETS.minimal, 'text')).toBe(true);
    });

    it('hides thinking in minimal', () => {
      expect(shouldShow(DISPLAY_PRESETS.minimal, 'thinking')).toBe(false);
    });

    it('shows thinking in debug', () => {
      expect(shouldShow(DISPLAY_PRESETS.debug, 'thinking')).toBe(true);
    });

    it('hides tool_call in minimal', () => {
      expect(shouldShow(DISPLAY_PRESETS.minimal, 'tool_call')).toBe(false);
    });

    it('shows tool_call in summary', () => {
      expect(shouldShow(DISPLAY_PRESETS.summary, 'tool_call')).toBe(true);
    });

    it('hides flightdeck_tool_call in summary preset', () => {
      expect(shouldShow(DISPLAY_PRESETS.summary, 'flightdeck_tool_call')).toBe(false);
    });

    it('shows flightdeck_tool_call in debug', () => {
      expect(shouldShow(DISPLAY_PRESETS.debug, 'flightdeck_tool_call')).toBe(true);
    });

    it('respects per-tool overrides', () => {
      const config: DisplayConfig = {
        ...DISPLAY_PRESETS.minimal,
        toolOverrides: { 'shell': 'detail' },
      };
      expect(shouldShow(config, 'tool_call', 'shell')).toBe(true);
      expect(shouldShow(config, 'tool_call', 'write_file')).toBe(false);
    });
  });

  describe('getVisibility', () => {
    it('returns detail for thinking when enabled', () => {
      expect(getVisibility(DISPLAY_PRESETS.debug, 'thinking')).toBe('detail');
    });

    it('returns off for thinking when disabled', () => {
      expect(getVisibility(DISPLAY_PRESETS.minimal, 'thinking')).toBe('off');
    });

    it('always returns ToolVisibility (never boolean)', () => {
      const vis = getVisibility(DISPLAY_PRESETS.debug, 'thinking');
      expect(typeof vis).toBe('string');
      const vis2 = getVisibility(DISPLAY_PRESETS.minimal, 'thinking');
      expect(typeof vis2).toBe('string');
    });

    it('returns ToolVisibility for tool_call', () => {
      expect(getVisibility(DISPLAY_PRESETS.summary, 'tool_call')).toBe('summary');
      expect(getVisibility(DISPLAY_PRESETS.debug, 'tool_call')).toBe('detail');
    });

    it('per-tool override wins', () => {
      const config: DisplayConfig = {
        ...DISPLAY_PRESETS.minimal,
        toolOverrides: { 'read': 'summary' },
      };
      expect(getVisibility(config, 'tool_call', 'read')).toBe('summary');
      expect(getVisibility(config, 'tool_call', 'write')).toBe('off');
    });
  });

  describe('mergeDisplayConfig', () => {
    it('merges partial into base', () => {
      const result = mergeDisplayConfig(DEFAULT_DISPLAY, { thinking: true });
      expect(result.thinking).toBe(true);
      expect(result.toolCalls).toBe('summary'); // unchanged
    });

    it('merges toolOverrides additively', () => {
      const base: DisplayConfig = { ...DEFAULT_DISPLAY, toolOverrides: { a: 'off' } };
      const result = mergeDisplayConfig(base, { toolOverrides: { b: 'detail' } });
      expect(result.toolOverrides).toEqual({ a: 'off', b: 'detail' });
    });

    it('removes toolOverrides with null value', () => {
      const base: DisplayConfig = { ...DEFAULT_DISPLAY, toolOverrides: { a: 'off', b: 'detail' } };
      const result = mergeDisplayConfig(base, { toolOverrides: { a: null } });
      expect(result.toolOverrides).toEqual({ b: 'detail' });
    });

    it('sets toolOverrides to undefined when all deleted', () => {
      const base: DisplayConfig = { ...DEFAULT_DISPLAY, toolOverrides: { a: 'off' } };
      const result = mergeDisplayConfig(base, { toolOverrides: { a: null } });
      expect(result.toolOverrides).toBeUndefined();
    });

    it('keeps base when partial is empty', () => {
      const result = mergeDisplayConfig(DEFAULT_DISPLAY, {});
      expect(result).toEqual(DEFAULT_DISPLAY);
    });
  });

  describe('validation', () => {
    it('isValidToolVisibility accepts valid values', () => {
      expect(isValidToolVisibility('off')).toBe(true);
      expect(isValidToolVisibility('summary')).toBe(true);
      expect(isValidToolVisibility('detail')).toBe(true);
      expect(isValidToolVisibility('foo')).toBe(false);
      expect(isValidToolVisibility(123)).toBe(false);
    });

    it('isValidDisplayConfig accepts valid partial configs', () => {
      expect(isValidDisplayConfig({})).toBe(true);
      expect(isValidDisplayConfig({ thinking: true })).toBe(true);
      expect(isValidDisplayConfig({ toolCalls: 'summary' })).toBe(true);
      expect(isValidDisplayConfig({ flightdeckTools: 'detail' })).toBe(true);
      expect(isValidDisplayConfig({ toolOverrides: { foo: 'off' } })).toBe(true);
    });

    it('isValidDisplayConfig rejects invalid configs', () => {
      expect(isValidDisplayConfig(null)).toBe(false);
      expect(isValidDisplayConfig('string')).toBe(false);
      expect(isValidDisplayConfig({ thinking: 'yes' })).toBe(false);
      expect(isValidDisplayConfig({ toolCalls: 'none' })).toBe(false);
      expect(isValidDisplayConfig({ toolOverrides: { foo: 'invalid' } })).toBe(false);
      expect(isValidDisplayConfig({ toolOverrides: ['array'] })).toBe(false);
    });

    it('isValidDisplayConfig accepts null in toolOverrides', () => {
      expect(isValidDisplayConfig({ toolOverrides: { foo: null } })).toBe(true);
      expect(isValidDisplayConfig({ toolOverrides: { foo: 'off', bar: null } })).toBe(true);
    });
  });

  describe('content type tagging', () => {
    it('flightdeck tool detection by prefix', () => {
      const toolNames = [
        'flightdeck_task_list',
        'flightdeck_status',
        'flightdeck_agent_list',
      ];
      for (const name of toolNames) {
        expect(isFlightdeckTool(name)).toBe(true);
      }
    });

    it('non-flightdeck tools are not tagged as flightdeck', () => {
      const toolNames = ['shell', 'write_file', 'read_file', 'search'];
      for (const name of toolNames) {
        expect(isFlightdeckTool(name)).toBe(false);
      }
    });
  });
});
