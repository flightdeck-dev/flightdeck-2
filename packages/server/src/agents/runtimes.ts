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
  adapter: 'acp' | 'pty' | 'copilot-sdk';
  /** Implementation notes and gotchas */
  notes: string | string[];
  /** Icon emoji */
  icon?: string;
  /** Documentation URL */
  docsUrl?: string;
  /** Setup/install links */
  setupLinks?: Array<{ label: string; url: string }>;
  /** Login/auth instructions */
  loginInstructions?: string;
  /** Install command hint */
  installHint?: string;
  /** Whether this runtime should be disabled by default in new projects */
  disabledByDefault?: boolean;
  /** Whether model discovery (probe via session/new) works cleanly. Defaults to true for ACP runtimes. */
  supportsModelDiscovery?: boolean;
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
    command: 'codex-acp',
    args: [],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: true,
    adapter: 'acp',
    icon: '🤖',
    docsUrl: 'https://github.com/openai/codex',
    setupLinks: [
      { label: 'ACP adapter', url: 'https://github.com/zed-industries/codex-acp' },
      { label: 'CLI quickstart', url: 'https://developers.openai.com/codex/quickstart/?setup=cli' },
    ],
    installHint: 'npm install -g @openai/codex',
    loginInstructions: 'Run codex auth in your terminal',
    notes: 'Codex ACP bridge. Reads AGENTS.md for system prompt. Config from ~/.codex/config.toml.',
  },

  copilot: {
    name: 'GitHub Copilot',
    command: 'copilot',
    args: [],
    systemPromptMethod: 'both',
    supportsAcp: false,
    supportsSessionLoad: false,
    adapter: 'copilot-sdk',
    icon: '🐙',
    docsUrl: 'https://github.com/github/copilot-sdk',
    setupLinks: [{ label: 'SDK Documentation', url: 'https://github.com/github/copilot-sdk' }],
    installHint: 'npm install @github/copilot-sdk',
    loginInstructions: 'Authenticate using the GitHub Copilot CLI (copilot auth login)',
    supportsModelDiscovery: true,
    notes: 'Uses @github/copilot-sdk for direct tool injection. No MCP subprocess needed. ' +
      'Tools are injected as native session tools via createSession({ tools }). ' +
      'Requires Copilot subscription with SDK access.',
  },

  'claude-agent': {
    name: 'Claude Agent (ACP)',
    command: 'claude-agent-acp',
    args: [],
    systemPromptMethod: 'meta-system-prompt',
    supportsAcp: true,
    supportsSessionLoad: false,
    adapter: 'acp',
    icon: '🟠',
    docsUrl: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview',
    setupLinks: [
      { label: 'ACP adapter', url: 'https://github.com/anthropics/claude-code-sdk-python' },
      { label: 'Claude Code', url: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview' },
    ],
    installHint: 'npm install -g @anthropic-ai/claude-code-acp',
    loginInstructions: 'Run claude auth in your terminal or set ANTHROPIC_API_KEY',
    supportsModelDiscovery: false,
    notes: 'Third-party ACP wrapper for Claude Code. Uses Anthropic API billing (more expensive).',
  },

  'claude-code': {
    name: 'Claude Code',
    command: 'claude',
    args: [],
    systemPromptMethod: 'both',
    supportsAcp: false,
    supportsSessionLoad: false,
    adapter: 'pty',
    icon: '🟣',
    docsUrl: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview',
    setupLinks: [{ label: 'Claude Code', url: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview' }],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    loginInstructions: 'Run claude auth in your terminal or set ANTHROPIC_API_KEY',
    supportsModelDiscovery: false,
    disabledByDefault: true,
    notes: [
      'Claude Code CLI via --print mode with session persistence (--resume).',
      'Uses Claude Code subscription (not API billing). Cheapest Claude option.',
      '--permission-mode auto skips permission prompts.',
    ],
  },

  gemini: {
    name: 'Gemini CLI (Google)',
    command: 'gemini',
    args: ['{prompt}'],
    systemPromptMethod: 'agents-md',
    supportsAcp: true,
    supportsSessionLoad: false,
    adapter: 'acp',
    icon: '💎',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    setupLinks: [{ label: 'Installation guide', url: 'https://geminicli.com/docs/get-started/installation/' }],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    loginInstructions: 'Run gemini auth in your terminal or set GEMINI_API_KEY',
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
    icon: '🔓',
    docsUrl: 'https://opencode.ai/docs/',
    setupLinks: [{ label: 'Documentation', url: 'https://opencode.ai/docs/' }],
    installHint: 'go install github.com/nicholasgriffintn/opencode@latest',
    loginInstructions: 'Authentication is managed by OpenCode',
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
