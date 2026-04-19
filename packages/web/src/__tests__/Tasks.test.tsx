import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

let mockTasks: any[] = [];
let mockLoading = false;
const mockRefresh = vi.fn();

vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projectName: 'test-project', connected: true, loading: mockLoading, refresh: mockRefresh }),
}));

vi.mock('../hooks/useTasks.tsx', () => ({
  useTasks: () => ({ tasks: mockTasks, decisions: [] }),
}));

vi.mock('../hooks/useChat.tsx', () => ({
  useChat: () => ({ messages: [], streamingMessages: new Map(), streamingChunks: new Map(), toolCallMap: new Map(), sendChat: vi.fn(), sendTaskComment: vi.fn(), interruptLead: vi.fn() }),
}));

vi.mock('../lib/api.ts', () => ({
  api: { createTask: vi.fn().mockResolvedValue({ id: 'new-task' }) },
}));

vi.mock('../components/Modal.tsx', () => ({
  Modal: ({ children, ...props }: any) => <div data-testid="modal" {...props}>{children}</div>,
  ModalHeader: ({ children }: any) => <div>{children}</div>,
  ModalFooter: ({ children }: any) => <div>{children}</div>,
}));

import Tasks from '../pages/Tasks.tsx';

describe('Tasks page', () => {
  beforeEach(() => {
    mockTasks = [];
    mockLoading = false;
    vi.clearAllMocks();
  });

  it('renders task count in header', () => {
    mockTasks = [
      { id: 't1', title: 'Task A', state: 'running', priority: 3, role: 'developer', description: '' },
      { id: 't2', title: 'Task B', state: 'done', priority: 2, role: 'developer', description: '' },
    ];
    render(<Tasks />);
    expect(screen.getByText('Tasks (2)')).toBeInTheDocument();
  });

  it('renders each task title', () => {
    mockTasks = [
      { id: 't1', title: 'Fix bug', state: 'running', priority: 3, role: 'developer', description: '' },
      { id: 't2', title: 'Add feature', state: 'pending', priority: 2, role: 'developer', description: '' },
    ];
    render(<Tasks />);
    expect(screen.getByText('Fix bug')).toBeInTheDocument();
    expect(screen.getByText('Add feature')).toBeInTheDocument();
  });

  it('shows state badge with correct text', () => {
    mockTasks = [
      { id: 't1', title: 'Task', state: 'in_review', priority: 3, role: 'dev', description: '' },
    ];
    render(<Tasks />);
    expect(screen.getByText('in review')).toBeInTheDocument();
  });

  it('filters tasks by state when filter clicked', () => {
    mockTasks = [
      { id: 't1', title: 'Running Task', state: 'running', priority: 3, role: 'dev', description: '' },
      { id: 't2', title: 'Done Task', state: 'done', priority: 3, role: 'dev', description: '' },
    ];
    render(<Tasks />);
    // Click "done" filter button (the one in the filter bar, not the badge)
    const doneButtons = screen.getAllByText(/^done/);
    // The filter button is the one without inline style (badge has style)
    const filterBtn = doneButtons.find(el => el.tagName === 'BUTTON') ?? doneButtons[0];
    fireEvent.click(filterBtn);
    expect(screen.getByText('Done Task')).toBeInTheDocument();
    expect(screen.queryByText('Running Task')).not.toBeInTheDocument();
  });

  it('shows empty state when no tasks', () => {
    render(<Tasks />);
    expect(screen.getByText(/No tasks/)).toBeInTheDocument();
  });

  it('shows empty state for filtered results', () => {
    mockTasks = [
      { id: 't1', title: 'Task', state: 'running', priority: 3, role: 'dev', description: '' },
    ];
    render(<Tasks />);
    const doneButtons2 = screen.getAllByText(/^done/);
    const filterBtn2 = doneButtons2.find(el => el.tagName === 'BUTTON') ?? doneButtons2[0];
    fireEvent.click(filterBtn2);
    expect(screen.getByText(/No tasks with state "done"/)).toBeInTheDocument();
  });

  it('shows loading skeleton when loading', () => {
    mockLoading = true;
    const { container } = render(<Tasks />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('expands task on click to show details', () => {
    mockTasks = [
      { id: 't1', title: 'Task 1', state: 'running', priority: 1, role: 'developer', description: 'Detailed desc', createdAt: '2026-01-01T00:00:00Z' },
    ];
    render(<Tasks />);
    // Click the task card to expand
    fireEvent.click(screen.getByText('Task 1'));
    expect(screen.getByText('Detailed desc')).toBeInTheDocument();
    expect(screen.getByText('Role: developer')).toBeInTheDocument();
  });

  it('shows priority indicator', () => {
    mockTasks = [
      { id: 't1', title: 'Critical', state: 'running', priority: 1, role: 'dev', description: '' },
    ];
    render(<Tasks />);
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('shows Create Task button', () => {
    render(<Tasks />);
    expect(screen.getByText('Create Task')).toBeInTheDocument();
  });

  it('shows filter buttons for all states', () => {
    render(<Tasks />);
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText(/^pending/)).toBeInTheDocument();
    expect(screen.getByText(/^running/)).toBeInTheDocument();
    expect(screen.getByText(/^done/)).toBeInTheDocument();
  });

  it('shows assigned agent', () => {
    mockTasks = [
      { id: 't1', title: 'Task', state: 'running', priority: 3, role: 'dev', description: '', assignedAgent: 'worker-1' },
    ];
    render(<Tasks />);
    expect(screen.getByText('worker-1')).toBeInTheDocument();
  });
});
