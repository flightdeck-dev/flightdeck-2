import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from '../components/Modal.tsx';

describe('Modal', () => {
  it('renders children', () => {
    render(<Modal onClose={() => {}} aria-label="Test"><p>Hello</p></Modal>);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('has role="dialog" and aria-modal', () => {
    render(<Modal onClose={() => {}} aria-label="Test">Content</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} aria-label="Test"><button>btn</button></Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose on overlay click', () => {
    const onClose = vi.fn();
    const { container } = render(<Modal onClose={onClose} aria-label="Test">Content</Modal>);
    // The overlay is the outer fixed div
    const overlay = container.firstChild as HTMLElement;
    fireEvent.mouseDown(overlay, { target: overlay, currentTarget: overlay });
    expect(onClose).toHaveBeenCalled();
  });

  it('focuses first focusable element', () => {
    render(<Modal onClose={() => {}} aria-label="Test"><button>First</button><button>Second</button></Modal>);
    expect(document.activeElement).toBe(screen.getByText('First'));
  });
});
