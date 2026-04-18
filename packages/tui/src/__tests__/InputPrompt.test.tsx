import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { InputPrompt } from '../components/InputPrompt';

const delay = (ms = 50) => new Promise(r => setTimeout(r, ms));

describe('InputPrompt', () => {
  it('renders prompt indicator', () => {
    const { lastFrame } = render(
      <InputPrompt value="" onChange={vi.fn()} onSubmit={vi.fn()} isActive={false} />
    );
    expect(lastFrame()).toContain('❯');
  });

  it('shows current value', () => {
    const { lastFrame } = render(
      <InputPrompt value="hello" onChange={vi.fn()} onSubmit={vi.fn()} isActive={false} />
    );
    expect(lastFrame()).toContain('hello');
  });

  it('calls onChange when key is typed', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <InputPrompt value="" onChange={onChange} onSubmit={vi.fn()} isActive={true} />
    );
    await delay();
    stdin.write('a');
    await delay();
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('appends character to existing value', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <InputPrompt value="he" onChange={onChange} onSubmit={vi.fn()} isActive={true} />
    );
    await delay();
    stdin.write('l');
    await delay();
    expect(onChange).toHaveBeenCalledWith('hel');
  });

  it('calls onSubmit on Enter with trimmed value', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputPrompt value="test" onChange={vi.fn()} onSubmit={onSubmit} isActive={true} />
    );
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSubmit).toHaveBeenCalledWith('test');
  });

  it('does not submit empty value', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputPrompt value="" onChange={vi.fn()} onSubmit={onSubmit} isActive={true} />
    );
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onExitInputMode on Escape', async () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <InputPrompt value="" onChange={vi.fn()} onSubmit={vi.fn()} isActive={true} onExitInputMode={onExit} />
    );
    await delay();
    stdin.write('\x1B');
    await delay();
    expect(onExit).toHaveBeenCalled();
  });

  it('does not process input when inactive', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <InputPrompt value="" onChange={onChange} onSubmit={vi.fn()} isActive={false} />
    );
    await delay();
    stdin.write('a');
    await delay();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('handles backspace', async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <InputPrompt value="abc" onChange={onChange} onSubmit={vi.fn()} isActive={true} />
    );
    await delay();
    stdin.write('\x7F');
    await delay();
    expect(onChange).toHaveBeenCalledWith('ab');
  });
});
