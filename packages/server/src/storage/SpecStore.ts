import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { SpecId } from '@flightdeck-ai/shared';
import { specId } from '@flightdeck-ai/shared';

export interface SpecFile {
  id: SpecId;
  filename: string;
  title: string;
  content: string;
}

export class SpecStore {
  constructor(private specsDir: string) {}

  list(): SpecFile[] {
    if (!existsSync(this.specsDir)) return [];
    const files = readdirSync(this.specsDir).filter(f => f.endsWith('.md'));
    return files.map(f => this.read(f)).filter((s): s is SpecFile => s !== null);
  }

  read(filename: string): SpecFile | null {
    const filepath = join(this.specsDir, filename);
    if (!existsSync(filepath)) return null;
    const content = readFileSync(filepath, 'utf-8');
    const title = this.extractTitle(content) || basename(filename, '.md');
    return {
      id: specId(filename),
      filename,
      title,
      content,
    };
  }

  write(filename: string, content: string): SpecFile {
    const filepath = join(this.specsDir, filename);
    mkdirSync(dirname(filepath), { recursive: true });
    writeFileSync(filepath, content);
    const title = this.extractTitle(content) || basename(filename, '.md');
    return { id: specId(filename), filename, title, content };
  }

  private extractTitle(content: string): string | null {
    const match = /^#\s+(.+)$/m.exec(content);
    return match ? match[1].trim() : null;
  }
}
