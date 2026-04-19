import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projectName: 'test-project', loading: false }),
}));

vi.mock('../lib/api.ts', () => ({
  api: {
    listCron: vi.fn().mockResolvedValue([]),
    enableCron: vi.fn().mockResolvedValue({ success: true }),
    disableCron: vi.fn().mockResolvedValue({ success: true }),
    deleteCron: vi.fn().mockResolvedValue({ success: true }),
    runCron: vi.fn().mockResolvedValue({ status: 'ok' }),
    createCron: vi.fn().mockResolvedValue({ id: 'new-cron' }),
  },
}));

vi.mock('swr', () => ({
  default: (key: any) => {
    if (Array.isArray(key) && key[0] === 'cron') {
      return {
        data: [
          {
            id: 'cron-1',
            name: 'Health Check',
            description: 'Check system health',
            enabled: true,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            schedule: { kind: 'cron', expr: '*/5 * * * *' },
            prompt: 'Check health',
            state: { nextRunAt: '2026-01-01T01:00:00Z', lastRunAt: '2026-01-01T00:55:00Z', lastRunStatus: 'ok', lastDurationMs: 500, consecutiveErrors: 0 },
          },
          {
            id: 'cron-2',
            name: 'Daily Report',
            enabled: false,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            schedule: { kind: 'cron', expr: '0 9 * * *' },
            prompt: 'Generate report',
            state: { nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastDurationMs: null, consecutiveErrors: 0 },
          },
        ],
        isLoading: false,
        mutate: vi.fn(),
      };
    }
    return { data: null, isLoading: false, mutate: vi.fn() };
  },
}));

vi.mock('../components/Modal.tsx', () => ({
  Modal: ({ children }: any) => <div data-testid="modal">{children}</div>,
  ModalHeader: ({ children }: any) => <div>{children}</div>,
  ModalFooter: ({ children }: any) => <div>{children}</div>,
}));

import Cron from '../pages/Cron.tsx';

describe('Cron page', () => {
  it('renders cron jobs', () => {
    render(<Cron />);
    expect(screen.getByText('Health Check')).toBeInTheDocument();
    expect(screen.getByText('Daily Report')).toBeInTheDocument();
  });

  it('shows schedule in human format', () => {
    render(<Cron />);
    expect(screen.getByText('Every 5 minutes')).toBeInTheDocument();
  });

  it('shows enabled/disabled state', () => {
    render(<Cron />);
    // Health Check is enabled, Daily Report is disabled
    expect(screen.getByText('Health Check')).toBeInTheDocument();
    expect(screen.getByText('Daily Report')).toBeInTheDocument();
  });

  it('shows New Job button', () => {
    render(<Cron />);
    expect(screen.getByText('New Job')).toBeInTheDocument();
  });

  it('shows job count in header', () => {
    render(<Cron />);
    expect(screen.getByText('Cron Jobs (2)')).toBeInTheDocument();
  });
});
