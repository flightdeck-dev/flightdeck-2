import { createHash } from 'node:crypto';
import type { SpecId } from '@flightdeck-ai/shared';
import type { SpecStore } from '../storage/SpecStore.js';
import type { SqliteStore } from '../storage/SqliteStore.js';

export interface SpecChange {
  specId: SpecId;
  filename: string;
  oldHash: string | null;
  newHash: string;
  isNew: boolean;
}

/**
 * Detects spec file changes by comparing content hashes stored in SQLite.
 * Called during orchestrator tick to identify stale tasks (FR-008).
 */
export class SpecChangeDetector {
  constructor(
    private specStore: SpecStore,
    private sqliteStore: SqliteStore,
  ) {}

  /**
   * Scan all spec files and compare content hashes against stored values.
   * Returns list of specs that changed since last check.
   * Automatically updates stored hashes for changed specs.
   */
  checkForChanges(): SpecChange[] {
    const specs = this.specStore.list();
    const storedHashes = this.sqliteStore.getAllSpecHashes();
    const changes: SpecChange[] = [];

    for (const spec of specs) {
      const newHash = SpecChangeDetector.hashContent(spec.content);
      const oldHash = storedHashes.get(spec.id as string) ?? null;

      if (oldHash !== newHash) {
        changes.push({
          specId: spec.id,
          filename: spec.filename,
          oldHash,
          newHash,
          isNew: oldHash === null,
        });
        // Update stored hash
        this.sqliteStore.upsertSpecHash(spec.id, newHash);
      }

      // Remove from map so we can detect deletions
      storedHashes.delete(spec.id as string);
    }

    // Remaining entries in storedHashes are specs that were deleted
    // (not handling deletion-as-change for now — tasks linked to deleted specs
    //  would need different treatment)

    return changes;
  }

  /**
   * Initialize hashes for all current specs without reporting changes.
   * Call once on project creation to establish baseline.
   */
  seedHashes(): void {
    const specs = this.specStore.list();
    for (const spec of specs) {
      const hash = SpecChangeDetector.hashContent(spec.content);
      this.sqliteStore.upsertSpecHash(spec.id, hash);
    }
  }

  static hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
