import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- Mocks ---

vi.mock('../lib/api.ts', () => ({
  api: {
    sendAgentMessage: vi.fn().mockResolvedValue({}),
    wakeAgent: vi.fn().mockResolvedValue({}),
    retireAgent: vi.fn().mockResolvedValue({}),
    hibernateAgent: vi.fn().mockResolvedValue({}),
    setAgentModel: vi.fn().mockResolvedValue({}),
    getAgents: vi.fn().mockResolvedValue([]),
    getAgentOutput: vi.fn().mockResolvedValue({ lines: [] }),
    getAvailableModels: vi.fn().mockResolvedValue({}),
  },
}));

let mockAgents: any[] = [];
vi.mock('../hooks/useAgents.tsx', () => ({
  useAgents: () => ({ agents: mockAgents, agentOutputs: new Map(), agentStreamChunks: new Map() }),
}));

vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projectName: 'test-project', loading: false, connected: true }),
}));

vi.mock('../hooks/useTasks.tsx', () => ({
  useTasks: () => ({ tasks: [] }),
}));

vi.mock('../hooks/useChat.tsx', () => ({
  useChat: () => ({ toolCallMap: new Map() }),
}));

vi.mock('../hooks/useDisplay.tsx', () => ({
  useDisplay: () => ({ displayConfig: { thinking: 'summary', toolCalls: 'summary', flightdeckTools: 'summary' } }),
}));

vi.mock('swr', () => ({
  default: () => ({ data: null, error: null, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

import Agents from '../pages/Agents.tsx';
import { api } from '../lib/api.ts';

const mockApi = api as any;

const busyAgent = {
  id: 'worker-abc123',
  role: 'worker',
  runtime: 'acp',
  runtimeName: 'codex',
  model: 'gpt-4.1',
  status: 'busy',
  acpSessionId: 'sess-123',
  currentTask: null,
  costAccumulated: 0,
  lastHeartbeat: null,
};

const hibernatedAgent = {
  ...busyAgent,
  id: 'worker-def456',
  status: 'hibernated',
};

describe('Agents page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgents = [busyAgent];
  });

  it('shows agent card with runtimeName (not acp fallback)', () => {
    render(<Agents />);
    expect(screen.getByText('codex')).toBeInTheDocument();
  });

  it('shows agent card model from DB', () => {
    render(<Agents />);
    expect(screen.getByText('gpt-4.1')).toBeInTheDocument();
  });

  // --- Detail panel tests (click agent card to open) ---

  it('Enter key sends message in detail panel', async () => {
    render(<Agents />);
    // Click agent card to open detail panel
    fireEvent.click(screen.getByText('worker-abc123'));
    const textarea = screen.getByPlaceholderText(/Message this agent/);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(mockApi.sendAgentMessage).toHaveBeenCalledWith('test-project', 'worker-abc123', 'hello', undefined);
    });
  });

  it('Shift+Enter inserts newline (does not send)', () => {
    render(<Agents />);
    fireEvent.click(screen.getByText('worker-abc123'));
    const textarea = screen.getByPlaceholderText(/Message this agent/);
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(mockApi.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('Send button is disabled when input is empty', () => {
    render(<Agents />);
    fireEvent.click(screen.getByText('worker-abc123'));
    const sendBtn = screen.getByLabelText('Send message');
    expect(sendBtn).toBeDisabled();
  });

  it('Send failure shows toast', async () => {
    mockApi.sendAgentMessage.mockRejectedValueOnce(new Error('Network error'));
    render(<Agents />);
    fireEvent.click(screen.getByText('worker-abc123'));
    const textarea = screen.getByPlaceholderText(/Message this agent/);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByText(/Failed to send.*Network error/)).toBeInTheDocument();
    });
  });

  // --- AgentActionMenu tests ---

  it('Wake action calls api.wakeAgent', async () => {
    mockAgents = [hibernatedAgent];
    render(<Agents />);
    // Open action menu on the card
    const menuBtn = screen.getByRole('button', { name: '' });
    // The MoreHorizontal button doesn't have a label, find it by the menu pattern
    const moreButtons = document.querySelectorAll('button');
    // Find the menu trigger (MoreHorizontal icon button)
    let menuTrigger: HTMLElement | null = null;
    moreButtons.forEach(btn => {
      if (btn.querySelector('svg') && btn.closest('.group')) {
        const svgUse = btn.querySelector('svg');
        if (svgUse && !btn.getAttribute('aria-label')) {
          menuTrigger = btn;
        }
      }
    });
    // Simpler: just find by the opacity-0 group-hover pattern - click the card first to hover
    // Actually let's just query all buttons without aria-label in the card
    const card = screen.getByText('worker-def456').closest('.group')!;
    const actionBtn = card.querySelector('button:not([aria-label])') as HTMLElement;
    fireEvent.click(actionBtn);
    // Now click Wake
    const wakeBtn = await screen.findByText('Wake');
    fireEvent.click(wakeBtn);
    await waitFor(() => {
      expect(mockApi.wakeAgent).toHaveBeenCalledWith('test-project', 'worker-def456');
    });
  });

  it('Wake failure shows page toast', async () => {
    mockApi.wakeAgent.mockRejectedValueOnce(new Error('Agent not found'));
    mockAgents = [hibernatedAgent];
    render(<Agents />);
    const card = screen.getByText('worker-def456').closest('.group')!;
    const actionBtn = card.querySelector('button:not([aria-label])') as HTMLElement;
    fireEvent.click(actionBtn);
    const wakeBtn = await screen.findByText('Wake');
    fireEvent.click(wakeBtn);
    await waitFor(() => {
      expect(screen.getByText(/Agent not found/)).toBeInTheDocument();
    });
  });

  it('Retire action calls api.retireAgent', async () => {
    mockAgents = [hibernatedAgent];
    render(<Agents />);
    const card = screen.getByText('worker-def456').closest('.group')!;
    const actionBtn = card.querySelector('button:not([aria-label])') as HTMLElement;
    fireEvent.click(actionBtn);
    const retireBtn = await screen.findByText('Retire');
    fireEvent.click(retireBtn);
    await waitFor(() => {
      expect(mockApi.retireAgent).toHaveBeenCalledWith('test-project', 'worker-def456');
    });
  });

  it('AgentActionMenu shows hibernate/interrupt for busy agent', () => {
    mockAgents = [busyAgent];
    render(<Agents />);
    const card = screen.getByText('worker-abc123').closest('.group')!;
    const actionBtn = card.querySelector('button:not([aria-label])') as HTMLElement;
    fireEvent.click(actionBtn);
    expect(screen.getByText('Hibernate')).toBeInTheDocument();
    expect(screen.getByText('Interrupt')).toBeInTheDocument();
    expect(screen.queryByText('Wake')).not.toBeInTheDocument();
  });

  it('AgentActionMenu shows wake/retire for hibernated agent', () => {
    mockAgents = [hibernatedAgent];
    render(<Agents />);
    const card = screen.getByText('worker-def456').closest('.group')!;
    const actionBtn = card.querySelector('button:not([aria-label])') as HTMLElement;
    fireEvent.click(actionBtn);
    expect(screen.getByText('Wake')).toBeInTheDocument();
    expect(screen.getByText('Retire')).toBeInTheDocument();
    expect(screen.queryByText('Hibernate')).not.toBeInTheDocument();
    expect(screen.queryByText('Interrupt')).not.toBeInTheDocument();
  });
});
