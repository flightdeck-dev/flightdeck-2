// Model tiers: high (best quality), medium (balanced), fast (cheap/fast)
export type ModelTier = 'high' | 'medium' | 'fast';

export interface ModelInfo {
  modelId: string;
  tier: ModelTier;
  displayName: string;
}

// High: frontier models (worker + reviewer)
const HIGH_PATTERNS = [
  /opus/i,              // claude-opus-4-6, Claude Opus 4.6
  /gpt-5\.4/i,         // gpt-5.4
  /gemini-3\.1-pro/i,  // gemini-3.1-pro
  /grok-4/i,            // grok-4
  /\bo3\b/i,           // o3 reasoning
];
// Medium: balanced (lead + planner)
const MEDIUM_PATTERNS = [
  /sonnet/i,            // claude-sonnet-4-6, Claude Sonnet 4
  /o4-mini/i,           // o4-mini reasoning
  /gemini-3-pro/i,      // gemini-3-pro (previous gen)
];
// Fast: cheap/quick
const FAST_PATTERNS = [
  /haiku/i,             // claude-haiku-4-5
  /nano/i,              // gpt-4.1-nano
  /flash/i,             // gemini-3.1-flash, gemini-flash
];

/**
 * Cache of available models per runtime, categorized by tier.
 */
export class ModelRegistry {
  private cache = new Map<string, ModelInfo[]>();

  /**
   * Called after session/new returns availableModels.
   */
  registerModels(
    runtimeName: string,
    models: Array<{ modelId: string; name: string; description?: string | null }>,
  ): void {
    const infos = models.map(m => ({
      modelId: m.modelId,
      tier: this.classifyModel(m.modelId, m.name),
      displayName: m.name,
    }));
    this.cache.set(runtimeName, infos);
  }

  /**
   * Classify a model into a tier based on name patterns.
   */
  classifyModel(modelId: string, name: string): ModelTier {
    const text = `${modelId} ${name}`;
    // Check fast first (nano/haiku/flash won't false-match high/medium)
    if (FAST_PATTERNS.some(p => p.test(text))) return 'fast';
    // Check high before medium (e.g. gpt-5.4 must match high, not medium gpt-5)
    if (HIGH_PATTERNS.some(p => p.test(text))) return 'high';
    if (MEDIUM_PATTERNS.some(p => p.test(text))) return 'medium';
    // GPT-5 / gpt-5.2 without .4 → medium
    if (/gpt-5/i.test(text)) return 'medium';
    return 'medium'; // default
  }

  /**
   * Get models for a runtime, optionally filtered by tier.
   */
  getModels(runtimeName: string, tier?: ModelTier): ModelInfo[] {
    const models = this.cache.get(runtimeName) ?? [];
    if (!tier) return models;
    return models.filter(m => m.tier === tier);
  }

  /**
   * Get the best (first registered) model for a tier.
   */
  getDefaultForTier(runtimeName: string, tier: ModelTier): ModelInfo | null {
    const models = this.getModels(runtimeName, tier);
    return models[0] ?? null;
  }

  /**
   * Resolve a tier name or model ID to a concrete model ID.
   * If the input is a tier name ('high'/'medium'/'fast'), resolve to best available.
   * Otherwise treat as a literal model ID.
   */
  resolveModel(runtimeName: string, modelOrTier: string): string | null {
    const tiers: ModelTier[] = ['high', 'medium', 'fast'];
    if (tiers.includes(modelOrTier as ModelTier)) {
      const info = this.getDefaultForTier(runtimeName, modelOrTier as ModelTier);
      return info?.modelId ?? null;
    }
    return modelOrTier;
  }

  /**
   * Get all registered runtimes.
   */
  getRuntimes(): string[] {
    return [...this.cache.keys()];
  }

  /**
   * Get models grouped by tier.
   */
  getModelsGrouped(runtimeName: string): Record<ModelTier, ModelInfo[]> {
    const models = this.cache.get(runtimeName) ?? [];
    const result: Record<ModelTier, ModelInfo[]> = { high: [], medium: [], fast: [] };
    for (const m of models) {
      result[m.tier].push(m);
    }
    return result;
  }
}

/** Singleton model registry */
export const modelRegistry = new ModelRegistry();
