/**
 * Centralized runtime registry for Flightdeck agent providers.
 *
 * Each entry describes how to spawn and communicate with an AI coding agent.
 * ACP-compatible agents communicate over stdin/stdout using JSON-RPC (nd-JSON).
 */

export type SystemPromptMethod = 'agents-md' | 'meta-system-prompt' | 'both';

export interface RuntimeDefinition {
  /** Display name */
  name: string;
  /** CLI binary name */
  command: string;
  /** Default arguments for ACP mode */
  args: string[];
  /** How the agent receives system prompts */
  systemPromptMethod: SystemPromptMethod;
  /** Whether the agent supports the Agent Client Protocol */
  supportsAcp: boolean;
  /** Whether session/load is supported for restart/resume */
  supportsSessionLoad: boolean;
  /** Adapter type for Flightdeck */
  adapter: 'acp' | 'pty';
  /** Implementation notes and gotchas */
  notes: string;
}

/**
 * All known agent runtimes.
 *
 * Runtimes marked with supportsAcp: true can be spawned via AcpAdapter.
 * Others need PtyAdapter or a custom adapter (documented in notes).
 */
export const RUNTIME_REGISTRY: Record<string, RuntimeDefinition> = {
  codex: {
    name: 'OpenAI Codex CLI',
    command: 'codex',
    args: ['--message', '{prompt}', '--cwd', '{cwd}'],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: true,
    adapter: 'acp',
    notes: 'Reference ACP implementation by OpenAI. Reads AGENTS.md for system prompt.',
  },

  copilot: {
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    args: ['--acp', '--stdio', '--allow-all'],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: false,
    adapter: 'acp',
    notes: 'GitHub Copilot coding agent. --allow-all auto-approves permissions.',
  },

  'claude-code': {
    name: 'Claude Code (Anthropic)',
    command: 'claude-agent-acp',
    args: [],
    systemPromptMethod: 'meta-system-prompt',
    supportsAcp: true,
    supportsSessionLoad: false,
    adapter: 'acp',
    notes:
      'Claude Code ACP bridge. Binary is "claude-agent-acp" (npm: @anthropic-ai/claude-code-acp). ' +
      'System prompt injected via _meta.systemPrompt in session/new, NOT via AGENTS.md.',
  },

  gemini: {
    name: 'Gemini CLI (Google)',
    command: 'gemini',
    args: ['{prompt}'],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: false,
    adapter: 'acp',
    notes: 'Google Gemini CLI. Reference ACP implementation.',
  },

  opencode: {
    name: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: false,
    adapter: 'acp',
    notes:
      'OpenCode CLI with ACP subcommand. Starts an ACP server over stdin/stdout (nd-JSON). ' +
      'See https://opencode.ai/docs/acp/',
  },

  kiro: {
    name: 'Kiro CLI (Amazon/AWS)',
    command: 'kiro-cli',
    args: ['acp'],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: false,
    adapter: 'acp',
    notes:
      'Amazon Kiro CLI with ACP support. Binary is "kiro-cli". ' +
      'Supports slash commands, MCP tools, and session management via ACP extensions. ' +
      'See https://kiro.dev/docs/cli/acp/',
  },

  'kilo-code': {
    name: 'Kilo Code CLI',
    command: 'kilocode-cli',
    args: ['acp'],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: false,
    adapter: 'acp',
    notes:
      'Kilo Code CLI (fork of OpenCode, part of the Kilo agentic platform). ' +
      'npm: @kilocode/cli. Supports 500+ models via OpenRouter. ' +
      'ACP mode is inherited from OpenCode architecture.',
  },

  claude: {
    name: 'Claude Code (PTY mode)',
    command: 'claude',
    args: ['--message', '{prompt}'],
    systemPromptMethod: 'both',
    supportsAcp: false,
    supportsSessionLoad: false,
    adapter: 'pty',
    notes:
      'Legacy PTY-based Claude Code integration. Prefer "claude-code" (ACP) when available. ' +
      'Uses the native "claude" binary in interactive mode.',
  },

  // --- Non-ACP providers (documented for future adapter work) ---

  cursor: {
    name: 'Cursor',
    command: 'agent',
    args: ['acp'],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: true,
    adapter: 'acp',
    notes: [
      'Cursor CLI binary is `agent`. Auth via `agent login` or `--api-key` or CURSOR_API_KEY env.',
      'Supports session/load for resume. Supports MCP servers via .cursor/mcp.json.',
      'Modes: agent (full tools), plan (read-only), ask (Q&A).',
      'Reference: https://cursor.com/docs/cli/acp',
    ],
  },

  'hermes-agent': {
    name: 'Hermes Agent (Nous Research)',
    command: 'hermes',
    args: ['acp'],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: false,
    adapter: 'acp',
    notes: [
      'Self-evolving agent by Nous Research. General-purpose agent framework with CLI, Telegram, Discord, Slack gateways.',
      'Install: pip install hermes-agent[acp]. Launch: `hermes acp` or `hermes-acp`.',
      'Uses curated hermes-acp toolset (file, terminal, web, memory, skills, vision).',
      'Config: ~/.hermes/.env + ~/.hermes/config.yaml',
      'Reference: https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',
    ],
  },
};

/** Get only ACP-compatible runtimes */
export function getAcpRuntimes(): Record<string, RuntimeDefinition> {
  return Object.fromEntries(
    Object.entries(RUNTIME_REGISTRY).filter(([, r]) => r.supportsAcp),
  );
}

/** Get RuntimeConfig format compatible with SessionManager */
export function toRuntimeConfigs(): Record<string, { command: string; args: string[]; adapter: string }> {
  return Object.fromEntries(
    Object.entries(RUNTIME_REGISTRY).map(([key, r]) => [
      key,
      { command: r.command, args: r.args, adapter: r.adapter },
    ]),
  );
}
