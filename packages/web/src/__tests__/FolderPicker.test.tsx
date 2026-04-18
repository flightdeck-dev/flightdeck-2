import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FolderPicker } from '../components/FolderPicker.tsx';

beforeEach(() => {
  // Mock fetch for browse-directory
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      path: '/home/user',
      parent: '/home',
      entries: [{ name: 'projects', path: '/home/user/projects' }],
    }),
  }));
});

describe('FolderPicker', () => {
  it('renders modal with "Select Directory" title', async () => {
    render(<FolderPicker value="/home" onChange={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Select Directory')).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    // fetch never resolves
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<FolderPicker value="/home" onChange={() => {}} onClose={() => {}} />);
    // The Loader2 spinner has animate-spin class
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('calls onClose when Cancel clicked', async () => {
    const onClose = vi.fn();
    render(<FolderPicker value="/home" onChange={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onChange with current path when Select clicked', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<FolderPicker value="/home" onChange={onChange} onClose={onClose} />);
    // Wait for fetch to resolve
    await screen.findByText('projects');
    fireEvent.click(screen.getByText('Select'));
    expect(onChange).toHaveBeenCalledWith('/home/user');
    expect(onClose).toHaveBeenCalled();
  });
});
