import { readdirSync, existsSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Flightdeck } from '../facade.js';
import type { AgentAdapter } from '../agents/AgentAdapter.js';
import { FD_HOME } from '../cli/constants.js';

const PROJECTS_DIR = join(FD_HOME, 'projects');

/**
 * Manages multiple Flightdeck project instances in a single daemon.
 * Lazily creates and caches Flightdeck facades per project.
 */
export class ProjectManager {
  private instances = new Map<string, Flightdeck>();
  private adapter: AgentAdapter | null;

  constructor(adapter?: AgentAdapter | null) {
    this.adapter = adapter ?? null;
  }

  /** List all discovered project names from ~/.flightdeck/projects/ */
  list(): string[] {
    if (!existsSync(PROJECTS_DIR)) return [];
    return readdirSync(PROJECTS_DIR)
      .filter(name => {
        const dir = join(PROJECTS_DIR, name);
        return statSync(dir).isDirectory() && existsSync(join(dir, 'config.json')) && !existsSync(join(dir, '.archived'));
      })
      .sort();
  }

  /** Get (or lazily create) a Flightdeck instance for a project */
  get(name: string): Flightdeck | null {
    if (this.instances.has(name)) return this.instances.get(name)!;
    const dir = join(PROJECTS_DIR, name);
    if (!existsSync(dir)) return null;
    const fd = new Flightdeck(name, this.adapter);
    this.instances.set(name, fd);
    return fd;
  }

  /** Create a new project and return its Flightdeck instance */
  create(name: string): Flightdeck {
    if (this.instances.has(name)) return this.instances.get(name)!;
    // Flightdeck constructor auto-inits if project doesn't exist
    const fd = new Flightdeck(name, this.adapter);
    this.instances.set(name, fd);
    return fd;
  }

  /** Delete a project. Closes its instance and removes the directory. */
  delete(name: string): boolean {
    const dir = join(PROJECTS_DIR, name);
    if (!existsSync(dir)) return false;
    const fd = this.instances.get(name);
    if (fd) {
      fd.close();
      this.instances.delete(name);
    }
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Archive a project (hide from sidebar/CLI but keep all data) */
  archive(name: string): boolean {
    const dir = join(PROJECTS_DIR, name);
    if (!existsSync(dir)) return false;
    // Write archived marker
    writeFileSync(join(dir, '.archived'), new Date().toISOString());
    // Close instance so it doesn't appear in active list
    const fd = this.instances.get(name);
    if (fd) {
      fd.close();
      this.instances.delete(name);
    }
    return true;
  }

  /** Unarchive a project */
  unarchive(name: string): boolean {
    const archivedPath = join(PROJECTS_DIR, name, '.archived');
    if (!existsSync(archivedPath)) return false;
    rmSync(archivedPath, { force: true });
    return true;
  }

  /** List all projects including archived ones */
  listAll(): string[] {
    if (!existsSync(PROJECTS_DIR)) return [];
    return readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(PROJECTS_DIR, d.name, 'config.json')))
      .map(d => d.name);
  }

  /** Check if a project is archived */
  isArchived(name: string): boolean {
    return existsSync(join(PROJECTS_DIR, name, '.archived'));
  }

  /** Get the first project name (used as default for backward-compatible flat routes) */
  defaultProject(): string | null {
    const projects = this.list();
    return projects.length > 0 ? projects[0] : null;
  }

  /** Close all cached instances */
  closeAll(): void {
    for (const fd of this.instances.values()) {
      fd.close();
    }
    this.instances.clear();
  }

  /** Get all currently loaded instances */
  loaded(): Map<string, Flightdeck> {
    return this.instances;
  }
}
