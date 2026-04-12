#!/usr/bin/env node
// Thin wrapper to launch the Flightdeck MCP server via tsx.
// This is the bin entry for `npx flightdeck-mcp`.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverTs = join(__dirname, '..', 'src', 'mcp', 'server.ts');

try {
  execFileSync('npx', ['tsx', serverTs], {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  process.exit(err.status ?? 1);
}
