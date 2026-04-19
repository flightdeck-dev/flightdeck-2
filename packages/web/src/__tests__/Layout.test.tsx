import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../hooks/useProject.tsx', () => ({
  useProject: () => ({ projectName: 'test', status: { config: { name: 'test', governance: 'autonomous' } }, connected: true, loading: false }),
}));

vi.mock('../hooks/useAgents.tsx', () => ({
  useAgents: () => ({ agents: [], agentOutputs: new Map(), agentStreamChunks: new Map() }),
}));

vi.mock('../components/Sidebar.tsx', () => ({
  Sidebar: ({ collapsed }: { collapsed: boolean }) => <nav data-testid="sidebar">{collapsed ? 'collapsed' : 'expanded'}</nav>,
}));

vi.mock('../components/ErrorBoundary.tsx', () => ({
  SectionErrorBoundary: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('../components/ThemeToggle.tsx', () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">Theme</button>,
}));

vi.mock('../components/DisplaySettings.tsx', () => ({
  DisplaySettings: ({ onClose }: any) => <div data-testid="display-settings" onClick={onClose}>Settings</div>,
}));

vi.mock('../components/SearchDialog.tsx', () => ({
  SearchDialog: ({ onClose }: any) => <div data-testid="search-dialog" onClick={onClose}>Search</div>,
}));

vi.mock('react-router-dom', () => ({
  Outlet: () => <div data-testid="outlet">Page Content</div>,
}));

// Mock fetch for health check
global.fetch = vi.fn().mockResolvedValue({ ok: true });

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

import { Layout } from '../components/Layout.tsx';

describe('Layout', () => {
  it('renders header with Flightdeck branding', () => {
    render(<Layout />);
    expect(screen.getByText(/Flightdeck/)).toBeInTheDocument();
  });

  it('renders sidebar', () => {
    render(<Layout />);
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('renders outlet for route content', () => {
    render(<Layout />);
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('renders theme toggle', () => {
    render(<Layout />);
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('shows project name in header', () => {
    render(<Layout />);
    expect(screen.getByText('test')).toBeInTheDocument();
  });

  it('shows connection indicator', () => {
    const { container } = render(<Layout />);
    // Green dot for connected
    const dot = container.querySelector('.bg-green-500');
    expect(dot).toBeTruthy();
  });

  it('shows governance selector', () => {
    render(<Layout />);
    expect(screen.getByDisplayValue('autonomous')).toBeInTheDocument();
  });
});
