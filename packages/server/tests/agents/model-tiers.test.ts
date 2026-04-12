import { describe, it, expect } from 'vitest';
import { ModelRegistry, type ModelTier } from '../../src/agents/ModelTiers.js';

describe('ModelRegistry', () => {
  function createPopulated(): ModelRegistry {
    const reg = new ModelRegistry();
    reg.registerModels('copilot', [
      { modelId: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { modelId: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking' },
      { modelId: 'gpt-5.4', name: 'GPT-5.4' },
      { modelId: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { modelId: 'grok-4', name: 'Grok 4' },
      { modelId: 'o3', name: 'o3' },
      { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      { modelId: 'gpt-5', name: 'GPT-5' },
      { modelId: 'gpt-5.2', name: 'GPT-5.2' },
      { modelId: 'o4-mini', name: 'o4-mini' },
      { modelId: 'gemini-3-pro', name: 'Gemini 3 Pro' },
      { modelId: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      { modelId: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
      { modelId: 'gemini-3.1-flash', name: 'Gemini 3.1 Flash' },
      { modelId: 'gemini-flash', name: 'Gemini Flash' },
    ]);
    return reg;
  }

  describe('classifyModel', () => {
    const reg = new ModelRegistry();

    it('classifies high-tier models', () => {
      expect(reg.classifyModel('claude-opus-4-6', 'Claude Opus 4.6')).toBe('high');
      expect(reg.classifyModel('claude-opus-4-6-thinking', 'Claude Opus 4.6 Thinking')).toBe('high');
      expect(reg.classifyModel('gpt-5.4', 'GPT-5.4')).toBe('high');
      expect(reg.classifyModel('gemini-3.1-pro', 'Gemini 3.1 Pro')).toBe('high');
      expect(reg.classifyModel('grok-4', 'Grok 4')).toBe('high');
      expect(reg.classifyModel('o3', 'o3')).toBe('high');
    });

    it('classifies medium-tier models', () => {
      expect(reg.classifyModel('claude-sonnet-4-6', 'Claude Sonnet 4.6')).toBe('medium');
      expect(reg.classifyModel('claude-sonnet-4', 'Claude Sonnet 4')).toBe('medium');
      expect(reg.classifyModel('gpt-5', 'GPT-5')).toBe('medium');
      expect(reg.classifyModel('gpt-5.2', 'GPT-5.2')).toBe('medium');
      expect(reg.classifyModel('o4-mini', 'o4-mini')).toBe('medium');
      expect(reg.classifyModel('gemini-3-pro', 'Gemini 3 Pro')).toBe('medium');
    });

    it('classifies fast-tier models', () => {
      expect(reg.classifyModel('claude-haiku-4-5', 'Claude Haiku 4.5')).toBe('fast');
      expect(reg.classifyModel('gpt-4.1-nano', 'GPT-4.1 Nano')).toBe('fast');
      expect(reg.classifyModel('gemini-3.1-flash', 'Gemini 3.1 Flash')).toBe('fast');
      expect(reg.classifyModel('gemini-flash', 'Gemini Flash')).toBe('fast');
    });

    it('defaults unknown models to medium', () => {
      expect(reg.classifyModel('unknown-model', 'Some Model')).toBe('medium');
    });

    it('handles display name format from Copilot CLI', () => {
      expect(reg.classifyModel('some-id', 'Claude Sonnet 4.5')).toBe('medium');
      expect(reg.classifyModel('some-id', 'GPT-5.4 (copilot)')).toBe('high');
    });
  });

  describe('registerModels + getModels', () => {
    it('caches models per runtime', () => {
      const reg = createPopulated();
      const all = reg.getModels('copilot');
      expect(all.length).toBe(16);
    });

    it('filters by tier', () => {
      const reg = createPopulated();
      const high = reg.getModels('copilot', 'high');
      expect(high.length).toBe(6);
      expect(high.every(m => m.tier === 'high')).toBe(true);

      const fast = reg.getModels('copilot', 'fast');
      expect(fast.length).toBe(4);
      expect(fast.every(m => m.tier === 'fast')).toBe(true);
    });

    it('returns empty for unknown runtime', () => {
      const reg = createPopulated();
      expect(reg.getModels('nonexistent')).toEqual([]);
    });
  });

  describe('getDefaultForTier', () => {
    it('returns first model in tier', () => {
      const reg = createPopulated();
      const high = reg.getDefaultForTier('copilot', 'high');
      expect(high).not.toBeNull();
      expect(high!.tier).toBe('high');
    });

    it('returns null for empty tier', () => {
      const reg = new ModelRegistry();
      reg.registerModels('empty', []);
      expect(reg.getDefaultForTier('empty', 'high')).toBeNull();
    });
  });

  describe('resolveModel', () => {
    it('resolves tier to model ID', () => {
      const reg = createPopulated();
      const id = reg.resolveModel('copilot', 'high');
      expect(id).toBe('claude-opus-4-6');
    });

    it('passes through literal model ID', () => {
      const reg = createPopulated();
      expect(reg.resolveModel('copilot', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    });

    it('returns null for tier with no models', () => {
      const reg = new ModelRegistry();
      reg.registerModels('empty', []);
      expect(reg.resolveModel('empty', 'high')).toBeNull();
    });
  });

  describe('getModelsGrouped', () => {
    it('groups by tier', () => {
      const reg = createPopulated();
      const grouped = reg.getModelsGrouped('copilot');
      expect(grouped.high.length).toBe(6);
      expect(grouped.medium.length).toBe(6);
      expect(grouped.fast.length).toBe(4);
    });
  });

  describe('getRuntimes', () => {
    it('lists registered runtimes', () => {
      const reg = createPopulated();
      expect(reg.getRuntimes()).toEqual(['copilot']);
    });
  });
});
