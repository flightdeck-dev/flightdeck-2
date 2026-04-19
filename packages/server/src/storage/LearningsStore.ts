import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Learning {
  id: string;
  agentId: string;
  tags: string[];
  content: string;
  timestamp: string;
}

/**
 * Stores learnings as markdown entries in memory/learnings.md.
 * Format:
 * ## YYYY-MM-DD
 * - **tag1,tag2**: Content text [agent-id]
 */
export class LearningsStore {
  private filePath: string;

  constructor(projectDir: string) {
    this.filePath = join(projectDir, 'memory', 'learnings.md');
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      appendFileSync(this.filePath, '# Learnings\n');
    }
  }

  append(learning: { agentId: string; content: string; tags?: string[]; category?: string }): Learning {
    const entry: Learning = {
      id: randomUUID(),
      agentId: learning.agentId,
      tags: learning.tags ?? (learning.category ? [learning.category] : []),
      content: learning.content,
      timestamp: new Date().toISOString(),
    };

    const dateStr = entry.timestamp.slice(0, 10);
    const existing = existsSync(this.filePath) ? readFileSync(this.filePath, 'utf-8') : '';
    const dateHeader = `\n## ${dateStr}`;
    const tagStr = entry.tags.length > 0 ? entry.tags.join(',') : 'general';
    const line = `- **${tagStr}**: ${entry.content} [${entry.agentId}]\n`;

    if (existing.includes(`## ${dateStr}`)) {
      // Append under existing date section
      const idx = existing.indexOf(`## ${dateStr}`);
      const nextSection = existing.indexOf('\n## ', idx + 1);
      const insertAt = nextSection !== -1 ? nextSection : existing.length;
      const before = existing.slice(0, insertAt);
      const after = existing.slice(insertAt);
      const newContent = before.trimEnd() + '\n' + line + after;
      // Write atomically
      writeFileSync(this.filePath, newContent);
    } else {
      appendFileSync(this.filePath, dateHeader + '\n' + line);
    }

    return entry;
  }

  search(query: string): Learning[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8');
    const q = query.toLowerCase();
    const results: Learning[] = [];

    // Parse markdown entries
    const lines = content.split('\n');
    let currentDate = '';
    for (const line of lines) {
      const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        currentDate = dateMatch[1];
        continue;
      }
      const entryMatch = line.match(/^- \*\*([^*]+)\*\*: (.+?) \[([^\]]+)\]$/);
      if (entryMatch) {
        const [, tags, content, agentId] = entryMatch;
        if (content.toLowerCase().includes(q) || tags.toLowerCase().includes(q)) {
          results.push({
            id: `${currentDate}-${results.length}`,
            agentId,
            tags: tags.split(',').map(t => t.trim()),
            content,
            timestamp: `${currentDate}T00:00:00Z`,
          });
        }
      }
    }

    return results;
  }

  list(): Learning[] {
    return this.search('');
  }
}
