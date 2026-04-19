import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- Mocks ---

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ projectName: 'test-project' }),
    NavLink: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
  };
});

let mockProjects: any[] = [];
let mockRefresh = vi.fn();
vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projects: mockProjects, projectName: 'test-project', refresh: mockRefresh }),
}));

let mockAgents: any[] = [];
vi.mock('../hooks/useAgents.tsx', () => ({
  useAgents: () => ({ agents: mockAgents }),
}));

vi.mock('../lib/api.ts', () => ({
  api: {
    createProject: vi.fn().mockResolvedValue({}),
    getProjects: vi.fn().mockResolvedValue([]),
    deleteProject: vi.fn().mockResolvedValue({}),
    getEscalations: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('swr', () => ({
  default: (key: any, _fetcher: any) => {
    // For escalations, return mock data
    if (key && Array.isArray(key) && key[0] === 'escalations-pending') {
      return { data: mockEscalations, error: null };
    }
    return { data: null, error: null, mutate: vi.fn() };
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

// Mock fetch for archived projects
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ projects: [] }) }));

let mockEscalations: any[] = [];

import { Sidebar } from '../components/Sidebar.tsx';
import { api } from '../lib/api.ts';

const mockApi = api as any;

describe('Sidebar', () => {
  const onToggle = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgents = [];
    mockProjects = [];
    mockEscalations = [];
  });

  it('agent badge is clickable and navigates to /agents', () => {
    mockProjects = [{
      name: 'test-project',
      governance: 'autonomous',
      agentCount: 3,
      busyAgentCount: 1,
      taskStats: {},
      totalCost: 0,
    }];
    render(<Sidebar collapsed={false} onToggle={onToggle} />);
    // Find the agent count badge
    const badge = screen.getByText('3');
    fireEvent.click(badge);
    expect(mockNavigate).toHaveBeenCalledWith('/test-project/agents');
  });

  it('shows green pulsing dot when busyAgentCount > 0', () => {
    mockProjects = [{
      name: 'test-project',
      governance: 'autonomous',
      agentCount: 2,
      busyAgentCount: 1,
      taskStats: {},
      totalCost: 0,
    }];
    const { container } = render(<Sidebar collapsed={false} onToggle={onToggle} />);
    // Check for the pulsing dot with animate-pulse class
    const pulsingDot = container.querySelector('.animate-pulse.bg-emerald-400');
    expect(pulsingDot).toBeInTheDocument();
  });

  it('shows grey dot when busyAgentCount === 0', () => {
    mockProjects = [{
      name: 'test-project',
      governance: 'autonomous',
      agentCount: 2,
      busyAgentCount: 0,
      taskStats: {},
      totalCost: 0,
    }];
    const { container } = render(<Sidebar collapsed={false} onToggle={onToggle} />);
    // Grey dot = opacity-50, no animate-pulse
    const greyDot = container.querySelector('.opacity-50:not(.animate-pulse)');
    expect(greyDot).toBeInTheDocument();
  });

  it('badge hidden when agentCount === 0', () => {
    mockProjects = [{
      name: 'test-project',
      governance: 'autonomous',
      agentCount: 0,
      busyAgentCount: 0,
      taskStats: {},
      totalCost: 0,
    }];
    render(<Sidebar collapsed={false} onToggle={onToggle} />);
    // No agent count displayed
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('new project creation navigates to /{name}/chat', async () => {
    render(<Sidebar collapsed={false} onToggle={onToggle} />);
    // Click the + button to open create modal
    fireEvent.click(screen.getByTitle('Create project'));
    // Fill in the form
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'new-proj' } });
    fireEvent.change(screen.getByPlaceholderText(/home\/user/), { target: { value: '/tmp/test' } });
    // Submit
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(mockApi.createProject).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/new-proj/chat');
    });
  });

  it('escalation badge shows count', () => {
    mockEscalations = [{ id: '1' }, { id: '2' }];
    mockProjects = [{
      name: 'test-project',
      governance: 'autonomous',
      agentCount: 0,
      busyAgentCount: 0,
      taskStats: {},
      totalCost: 0,
    }];
    render(<Sidebar collapsed={false} onToggle={onToggle} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});
