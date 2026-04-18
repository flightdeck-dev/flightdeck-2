import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import { App } from './App';

// ── CLI Entry ──────────────────────────────────────────────────

const { values } = parseArgs({
  strict: false,
  options: {
    port: { type: 'string', default: '18800' },
    project: { type: 'string' },
    url: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`
Flightdeck TUI — Terminal interface for Flightdeck daemon

Usage:
  flightdeck tui [options]

Options:
  --port <port>   Port to connect to (default: 3000)
  --url <ws-url>  Full WebSocket URL
  -h, --help      Show help

Keyboard:
  Tab       Cycle panels (Tasks → Chat → Agents)
  j/k       Scroll up/down in focused panel
  t/c/a     Jump to Tasks/Chat/Agents
  Ctrl+T    Toggle Chat/Activity in center
  Enter     Enter input mode / send message
  /cmd      Commands: /help /tasks /agents /status /display /quit
  q         Quit
`);
  process.exit(0);
}

const port = values.port || '18800';
const wsUrl = (values.url as string) || `ws://localhost:${port}`;
const baseUrl = (values.url as string) ? (values.url as string).replace(/^ws(s?):/, 'http$1:') : `http://localhost:${port}`;

render(<App baseUrl={baseUrl} wsUrl={wsUrl} initialProject={values.project as string | undefined} />);
