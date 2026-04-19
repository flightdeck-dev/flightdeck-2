import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROLE_TOOLS } from '../../src/mcp/toolPermissions.js';
import { ALL_TOOL_NAMES } from '../../src/agents/toolNames.js';

/**
 * Extract tool names from source files by regex parsing.
 * This avoids needing to instantiate servers or call private methods.
 */
function extractMcpToolNames(): string[] {
  const src = readFileSync(resolve(__dirname, '../../src/mcp/server.ts'), 'utf-8');
  const names: string[] = [];
  for (const match of src.matchAll(/server\.tool\('(flightdeck_[^']+)'/g)) {
    names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

function extractSdkToolNames(): string[] {
  const src = readFileSync(resolve(__dirname, '../../src/agents/CopilotSdkAdapter.ts'), 'utf-8');
  const names: string[] = [];
  for (const match of src.matchAll(/name:\s*'(flightdeck_[^']+)'/g)) {
    names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

describe('Tool name synchronization', () => {
  const mcpTools = extractMcpToolNames();
  const sdkTools = extractSdkToolNames();

  it('MCP and SDK should define the exact same set of tool names', () => {
    const mcpOnly = mcpTools.filter(t => !sdkTools.includes(t));
    const sdkOnly = sdkTools.filter(t => !mcpTools.includes(t));

    if (mcpOnly.length > 0 || sdkOnly.length > 0) {
      const msg = [
        mcpOnly.length > 0 ? `MCP-only tools (missing from SDK): ${mcpOnly.join(', ')}` : '',
        sdkOnly.length > 0 ? `SDK-only tools (missing from MCP): ${sdkOnly.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      expect.fail(msg);
    }
  });

  it('toolNames.ts ALL_TOOL_NAMES should match MCP server tools', () => {
    const sorted = [...ALL_TOOL_NAMES].sort();
    const mcpSorted = [...mcpTools].sort();
    expect(sorted).toEqual(mcpSorted);
  });

  describe('Per-role tool coverage (toolPermissions vs SDK availability)', () => {
    const roles = Object.keys(ROLE_TOOLS);

    for (const role of roles) {
      it(`role "${role}" — all permitted tools exist in SDK`, () => {
        const permitted = ROLE_TOOLS[role];
        const missingFromSdk = permitted.filter(t => !sdkTools.includes(t));
        if (missingFromSdk.length > 0) {
          expect.fail(`Role "${role}" permits tools not in SDK: ${missingFromSdk.join(', ')}`);
        }
      });

      it(`role "${role}" — all permitted tools exist in MCP`, () => {
        const permitted = ROLE_TOOLS[role];
        const missingFromMcp = permitted.filter(t => !mcpTools.includes(t));
        if (missingFromMcp.length > 0) {
          expect.fail(`Role "${role}" permits tools not in MCP: ${missingFromMcp.join(', ')}`);
        }
      });
    }
  });

  it('every tool in toolPermissions exists in the canonical ALL_TOOL_NAMES', () => {
    const allPermitted = new Set(Object.values(ROLE_TOOLS).flat());
    const missing = [...allPermitted].filter(t => !ALL_TOOL_NAMES.includes(t));
    if (missing.length > 0) {
      expect.fail(`Tools in permissions but not in toolNames.ts: ${missing.join(', ')}`);
    }
  });

  it('no duplicate tool definitions in SDK buildTools', () => {
    const src = readFileSync(resolve(__dirname, '../../src/agents/CopilotSdkAdapter.ts'), 'utf-8');
    const names: string[] = [];
    for (const match of src.matchAll(/name:\s*'(flightdeck_[^']+)'/g)) {
      names.push(match[1]);
    }
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of names) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    if (dupes.length > 0) {
      expect.fail(`Duplicate tool names in SDK: ${dupes.join(', ')}`);
    }
  });
});
