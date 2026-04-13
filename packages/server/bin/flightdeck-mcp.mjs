#!/usr/bin/env node

/**
 * flightdeck-mcp — MCP server for Flightdeck 2.0
 *
 * Usage:
 *   flightdeck-mcp                          # auto-detect project from cwd
 *   flightdeck-mcp --project myproject      # explicit project name
 *   FLIGHTDECK_AGENT_ID=... flightdeck-mcp  # set calling agent ID
 *   FLIGHTDECK_AGENT_ROLE=worker flightdeck-mcp  # role-based tool filtering
 */

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, '..');

// Parse args
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.error(`flightdeck-mcp — MCP server for Flightdeck 2.0

Usage:
  flightdeck-mcp [options]

Options:
  --project <name>   Project name (default: auto-detect from cwd)
  -h, --help         Show this help message
  -v, --version      Show version

Environment:
  FLIGHTDECK_AGENT_ID    Agent ID for the calling agent
  FLIGHTDECK_AGENT_ROLE  Role for tool filtering (lead/planner/worker/reviewer/...)`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const { readFileSync } = await import('fs');
  const pkg = JSON.parse(readFileSync(resolve(serverRoot, 'package.json'), 'utf-8'));
  console.error(pkg.version);
  process.exit(0);
}

// Try compiled dist first, then fall back to tsx for dev mode
import { existsSync } from 'fs';
const distEntry = resolve(serverRoot, 'dist', 'mcp', 'server.js');
const srcEntry = resolve(serverRoot, 'src', 'mcp', 'server.ts');

if (existsSync(distEntry)) {
  // Production: import compiled JS directly
  const { createMcpServer } = await import(distEntry);
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  let projectName;
  const projIdx = args.indexOf('--project');
  if (projIdx !== -1 && args[projIdx + 1]) {
    projectName = args[projIdx + 1];
  } else if (process.env.FLIGHTDECK_PROJECT) {
    projectName = process.env.FLIGHTDECK_PROJECT;
  }

  const server = createMcpServer(projectName ? { projectName } : undefined);
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  // Dev mode: re-exec via tsx
  const tsxBin = resolve(serverRoot, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxBin, [srcEntry, ...args], {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });

  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
