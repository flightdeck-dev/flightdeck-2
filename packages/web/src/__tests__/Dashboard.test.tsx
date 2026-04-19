import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock all hooks that Dashboard depends on
let mockTasks: any[] = [];
let mockAgents: any[] = [];
let mockMessages: any[] = [];
let mockStatus: any = null;
let mockLoading = false;

vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projectName: 'test-project', status: mockStatus, connected: true, loading: mockLoading, refresh: vi.fn() }),
}));

vi.mock('../hooks/useTasks.tsx', () => ({
  useTasks: () => ({ tasks: mockTasks, decisions: [] }),
}));

vi.mock('../hooks/useAgents.tsx', () => ({
  useAgents: () => ({ agents: mockAgents, agentOutputs: new Map(), agentStreamChunks: new Map() }),
}));

vi.mock('../hooks/useChat.tsx', () => ({
  useChat: () => ({ messages: mockMessages, streamingMessages: new Map(), streamingChunks: new Map(), toolCallMap: new Map(), sendChat: vi.fn(), interruptLead: vi.fn() }),
}));

vi.mock('../hooks/useDisplay.tsx', () => ({
  useDisplay: () => ({ displayConfig: { thinking: 'summary', toolCalls: 'summary', flightdeckTools: 'summary' } }),
}));

vi.mock('../lib/api.ts', () => ({
  api: {
    getEscalations: vi.fn().mockResolvedValue([]),
    resolveEscalation: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('swr', () => ({
  default: (key: any, fetcher: any) => {
    // For escalations SWR
    if (Array.isArray(key) && key[0] === 'escalations') {
      return { data: [], mutate: vi.fn() };
    }
    // For token-usage
    return { data: null, mutate: vi.fn(), isLoading: false };
  },
}));

vi.mock('../components/Markdown.tsx', () => ({
  Markdown: ({ content }: { content: string }) => <span>{content}</span>,
}));

import Dashboard from '../pages/Dashboard.tsx';

describe('Dashboard', () => {
  beforeEach(() => {
    mockTasks = [];
    mockAgents = [];
    mockMessages = [];
    mockStatus = { config: { name: 'Test Project', governance: 'autonomous' }, taskStats: {}, agentCount: 0, totalCost: 0 };
    mockLoading = false;
  });

  it('renders project name', () => {
    render(<Dashboard />);
    expect(screen.getByText('Test Project')).toBeInTheDocument();
  });

  it('shows governance type', () => {
    render(<Dashboard />);
    expect(screen.getByText('autonomous governance')).toBeInTheDocument();
  });

  it('shows task count', () => {
    mockTasks = [
      { id: 't1', title: 'Task 1', state: 'running', priority: 3, role: 'developer' },
      { id: 't2', title: 'Task 2', state: 'done', priority: 3, role: 'developer' },
    ];
    render(<Dashboard />);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('tasks')).toBeInTheDocument();
  });

  it('shows active agent count (excluding terminated)', () => {
    mockAgents = [
      { id: 'a1', role: 'developer', status: 'busy' },
      { id: 'a2', role: 'lead', status: 'terminated' },
    ];
    render(<Dashboard />);
    // 1 active agent
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('agents')).toBeInTheDocument();
  });

  it('shows loading skeleton when loading', () => {
    mockLoading = true;
    const { container } = render(<Dashboard />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows pipeline columns', () => {
    render(<Dashboard />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('In Review')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('renders tasks in correct pipeline columns', () => {
    mockTasks = [
      { id: 't1', title: 'Running Task', state: 'running', priority: 3, role: 'dev' },
      { id: 't2', title: 'Done Task', state: 'done', priority: 3, role: 'dev' },
    ];
    render(<Dashboard />);
    expect(screen.getByText('Running Task')).toBeInTheDocument();
    expect(screen.getByText('Done Task')).toBeInTheDocument();
  });

  it('shows "No messages from Lead yet" when no lead messages', () => {
    render(<Dashboard />);
    expect(screen.getByText('No messages from Lead yet')).toBeInTheDocument();
  });

  it('shows lead message when available', () => {
    mockMessages = [
      { id: 'm1', authorType: 'lead', content: 'Hello from the lead!', createdAt: new Date().toISOString(), threadId: null },
    ];
    render(<Dashboard />);
    expect(screen.getByText('Hello from the lead!')).toBeInTheDocument();
  });

  it('shows "No agents running" when no active agents', () => {
    render(<Dashboard />);
    expect(screen.getByText(/No agents running/)).toBeInTheDocument();
  });

  it('shows active agents with status', () => {
    mockAgents = [
      { id: 'a1', role: 'developer', status: 'busy', model: 'claude-3' },
    ];
    render(<Dashboard />);
    expect(screen.getByText('developer')).toBeInTheDocument();
    expect(screen.getByText('busy')).toBeInTheDocument();
    expect(screen.getByText('claude-3')).toBeInTheDocument();
  });

  it('shows Flightdeck as fallback name when no status', () => {
    mockStatus = null;
    render(<Dashboard />);
    expect(screen.getByText('Flightdeck')).toBeInTheDocument();
  });
});
