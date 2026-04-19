import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projectName: 'test-project', status: { config: { name: 'test', governance: 'autonomous' } }, connected: true, loading: false }),
}));

vi.mock('../hooks/useDisplay.tsx', () => ({
  useDisplay: () => ({
    displayConfig: { thinking: 'summary', toolCalls: 'summary', flightdeckTools: 'summary' },
    setDisplayConfig: vi.fn(),
    applyDisplayPreset: vi.fn(),
  }),
}));

vi.mock('../hooks/useAgents.tsx', () => ({
  useAgents: () => ({ agents: [{ id: 'a1', role: 'developer', status: 'busy', model: 'claude-3' }] }),
}));

vi.mock('swr', () => ({
  default: (key: any) => {
    if (key === 'projects-for-settings') {
      return { data: [{ name: 'test-project', governance: 'autonomous' }] };
    }
    if (Array.isArray(key) && key[0] === 'runtimes') {
      return { data: [{ id: 'rt1', name: 'Codex', command: 'codex', supportsAcp: true, adapter: 'acp' }], isLoading: false };
    }
    if (key === 'global-config') {
      return { data: { disabledRuntimes: [], timezone: 'America/Los_Angeles' }, mutate: vi.fn() };
    }
    if (Array.isArray(key) && key[0] === 'models') {
      return { data: { 'claude-3': {} }, isLoading: false };
    }
    return { data: null, isLoading: false, mutate: vi.fn() };
  },
}));

vi.mock('../lib/api.ts', () => ({
  api: {
    getRuntimes: vi.fn().mockResolvedValue([]),
    testRuntime: vi.fn().mockResolvedValue({ success: true, installed: true, version: '1.0', message: 'ok' }),
    getModels: vi.fn().mockResolvedValue({}),
    updateProjectConfig: vi.fn().mockResolvedValue({}),
  },
}));

import Settings from '../pages/Settings.tsx';

describe('Settings page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<Settings />);
    // Settings page should render
    expect(document.body).toBeTruthy();
  });

  it('renders settings content with sections', () => {
    const { container } = render(<Settings />);
    const text = container.textContent ?? '';
    // Verify the component renders meaningful content
    expect(text.length).toBeGreaterThan(50);
  });

  it('shows Runtimes section', () => {
    const { container } = render(<Settings />);
    expect(container.textContent).toContain('Runtime');
  });

  it('shows project and identity sections', () => {
    const { container } = render(<Settings />);
    const text = container.textContent ?? '';
    expect(text).toContain('Project');
  });
});
