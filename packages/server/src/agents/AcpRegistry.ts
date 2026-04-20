/**
 * ACP Agent Registry — fetches and caches the public ACP agent registry
 * from cdn.agentclientprotocol.com for runtime discovery and icons.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const CACHE_FILE = join(homedir(), '.flightdeck', 'v2', 'acp-registry-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  repository?: string;
  website?: string;
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<string, { archive: string; cmd: string; args?: string[] }>;
  };
}

export interface Registry {
  version: string;
  agents: RegistryAgent[];
}

export class AcpRegistry {
  private cache: Registry | null = null;

  async getAgents(): Promise<RegistryAgent[]> {
    if (this.cache) return this.cache.agents;

    // Try disk cache first
    if (existsSync(CACHE_FILE)) {
      try {
        const raw = readFileSync(CACHE_FILE, 'utf-8');
        const { data, fetchedAt } = JSON.parse(raw);
        if (Date.now() - fetchedAt < CACHE_TTL_MS) {
          this.cache = data;
          return data.agents;
        }
      } catch { /* ignore corrupt cache */ }
    }

    // Fetch fresh
    return this.refresh();
  }

  async refresh(): Promise<RegistryAgent[]> {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) {
      throw new Error(`Failed to fetch ACP registry: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as Registry;
    this.cache = data;

    // Save to disk
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify({ data, fetchedAt: Date.now() }));
    } catch { /* best effort */ }

    return data.agents;
  }
}

export const acpRegistry = new AcpRegistry();
