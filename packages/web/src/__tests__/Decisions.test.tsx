import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

let mockDecisions: any[] = [];
let mockLoading = false;

vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projectName: 'test-project', loading: mockLoading }),
}));

vi.mock('../hooks/useTasks.tsx', () => ({
  useTasks: () => ({ tasks: [], decisions: mockDecisions }),
}));

import Decisions from '../pages/Decisions.tsx';

describe('Decisions page', () => {
  beforeEach(() => {
    mockDecisions = [];
    mockLoading = false;
  });

  it('renders header', () => {
    render(<Decisions />);
    expect(screen.getByText(/Decisions/)).toBeInTheDocument();
  });

  it('shows empty state when no decisions', () => {
    render(<Decisions />);
    expect(screen.getByText(/No decisions recorded yet/)).toBeInTheDocument();
  });

  it('renders decision cards', () => {
    mockDecisions = [
      { id: 'd1', title: 'Use React', category: 'architecture', status: 'confirmed', rationale: 'Best for this use case', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'd2', title: 'Add caching', category: 'implementation', status: 'recorded', rationale: 'Performance boost', timestamp: '2026-01-02T00:00:00Z' },
    ];
    render(<Decisions />);
    expect(screen.getByText('Use React')).toBeInTheDocument();
    expect(screen.getByText('Add caching')).toBeInTheDocument();
  });

  it('shows decision status', () => {
    mockDecisions = [
      { id: 'd1', title: 'Decision 1', category: 'design', status: 'rejected', rationale: 'Not needed', timestamp: '2026-01-01T00:00:00Z' },
    ];
    render(<Decisions />);
    expect(screen.getByText('rejected')).toBeInTheDocument();
  });

  it('shows decision category', () => {
    mockDecisions = [
      { id: 'd1', title: 'Decision 1', category: 'architecture', status: 'confirmed', rationale: 'Reason', timestamp: '2026-01-01T00:00:00Z' },
    ];
    render(<Decisions />);
    expect(screen.getByText(/architecture/)).toBeInTheDocument();
  });

  it('shows loading skeleton', () => {
    mockLoading = true;
    const { container } = render(<Decisions />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});
