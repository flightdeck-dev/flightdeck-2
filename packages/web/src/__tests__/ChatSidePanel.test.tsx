import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock all hooks used by ChatSidePanel
vi.mock('../hooks/useTasks.tsx', () => ({ useTasks: () => ({ tasks: [] }) }));
vi.mock('../hooks/useAgents.tsx', () => ({ useAgents: () => ({ agents: [] }) }));
vi.mock('../hooks/useProject.tsx', () => ({ useProject: () => ({ projectName: 'test' }) }));
vi.mock('../lib/api.ts', () => ({ api: { search: vi.fn().mockResolvedValue({ messages: [] }) } }));

// Mock localStorage
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
});

import { ChatSidePanel } from '../components/ChatSidePanel.tsx';

function clearStore() {
  for (const k of Object.keys(store)) delete store[k];
}

describe('ChatSidePanel', () => {
  beforeEach(() => clearStore());

  it('renders icon bar when collapsed', () => {
    render(<ChatSidePanel />);
    expect(screen.getByLabelText('Tasks')).toBeInTheDocument();
    expect(screen.getByLabelText('Agents')).toBeInTheDocument();
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByLabelText('Memory')).toBeInTheDocument();
  });

  it('expands when icon clicked and shows tab label', () => {
    render(<ChatSidePanel />);
    fireEvent.click(screen.getByLabelText('Tasks'));
    expect(screen.getByText('Tasks')).toBeInTheDocument();
  });

  it('shows tasks tab content when opened', () => {
    render(<ChatSidePanel />);
    fireEvent.click(screen.getByLabelText('Tasks'));
    expect(screen.getByText('No tasks')).toBeInTheDocument();
  });

  it('collapses when same tab clicked again', () => {
    render(<ChatSidePanel />);
    fireEvent.click(screen.getByLabelText('Tasks'));
    expect(screen.getByText('No tasks')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Tasks'));
    expect(screen.queryByText('No tasks')).not.toBeInTheDocument();
  });
});
