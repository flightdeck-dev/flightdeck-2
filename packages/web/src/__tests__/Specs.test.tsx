import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projectName: 'test-project', loading: false }),
}));

vi.mock('../lib/api.ts', () => ({
  api: {
    getSpecs: vi.fn().mockResolvedValue([]),
    getReport: vi.fn().mockResolvedValue(''),
  },
}));

vi.mock('swr', () => ({
  default: (key: any) => {
    if (Array.isArray(key) && key[0] === 'specs') {
      return { data: [{ id: 's1', filename: 'spec.md', title: 'API Spec', content: '# API\nEndpoints...' }], isLoading: false };
    }
    if (Array.isArray(key) && key[0] === 'report') {
      return { data: '# Daily Report\nAll good.', isLoading: false };
    }
    return { data: null, isLoading: false };
  },
}));

vi.mock('../components/Markdown.tsx', () => ({
  Markdown: ({ content }: { content: string }) => <span>{content}</span>,
}));

import Specs from '../pages/Specs.tsx';

describe('Specs page', () => {
  it('renders header', () => {
    render(<Specs />);
    expect(screen.getByText('Specs & Reports')).toBeInTheDocument();
  });

  it('shows spec file in sidebar', () => {
    render(<Specs />);
    expect(screen.getAllByText('API Spec').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('spec.md')).toBeInTheDocument();
  });

  it('shows daily report link', () => {
    render(<Specs />);
    expect(screen.getByText('Daily Report')).toBeInTheDocument();
  });

  it('shows spec content when selected (auto-selects first)', () => {
    render(<Specs />);
    // Title appears in sidebar + detail panel
    expect(screen.getAllByText('API Spec').length).toBe(2);
  });
});
