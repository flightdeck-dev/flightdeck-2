import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ModelInfo {
  modelId: string;
  displayName: string;
}

/**
 * Cache of available models per runtime.
 */
export class ModelRegistry {
  private cache = new Map<string, ModelInfo[]>();
  private cacheFile = join(homedir(), '.flightdeck', 'v2', 'model-cache.json');

  /** Load cached models from disk (call on startup) */
  loadFromDisk(): void {
    try {
      if (existsSync(this.cacheFile)) {
        const data = JSON.parse(readFileSync(this.cacheFile, 'utf-8'));
        for (const [runtime, models] of Object.entries(data)) {
          if (!this.cache.has(runtime)) {
            // Strip unknown fields
            const cleaned = (models as any[]).map(m => ({
              modelId: m.modelId,
              displayName: m.displayName ?? m.name ?? m.modelId,
            }));
            this.cache.set(runtime, cleaned);
          }
        }
      }
    } catch { /* best effort */ }
  }

  /** Save current cache to disk */
  saveToDisk(): void {
    try {
      const dir = join(homedir(), '.flightdeck', 'v2');
      mkdirSync(dir, { recursive: true });
      const data: Record<string, ModelInfo[]> = {};
      for (const [k, v] of this.cache) data[k] = v;
      writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
    } catch { /* best effort */ }
  }

  /**
   * Called after session/new returns availableModels.
   */
  registerModels(
    runtimeName: string,
    models: Array<{ modelId: string; name: string; description?: string | null }>,
  ): void {
    const infos: ModelInfo[] = models.map(m => ({
      modelId: m.modelId,
      displayName: m.name,
    }));
    this.cache.set(runtimeName, infos);
    this.saveToDisk();
  }

  /**
   * Get models for a runtime.
   */
  getModels(runtimeName: string): ModelInfo[] {
    return this.cache.get(runtimeName) ?? [];
  }

  /**
   * Resolve a model ID. Just returns the input string.
   * If the input is a known model, great. If not, return it anyway
   * (user knows what they want).
   */
  resolveModel(_runtimeName: string, modelId: string): string | null {
    return modelId || null;
  }

  /**
   * Get all registered runtimes.
   */
  getRuntimes(): string[] {
    return [...this.cache.keys()];
  }
}

/** Singleton model registry */
export const modelRegistry = new ModelRegistry();
