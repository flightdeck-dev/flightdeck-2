import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SuggestionsDisplay } from '../components/SuggestionsDisplay';

describe('SuggestionsDisplay', () => {
  const suggestions = [
    { cmd: '/help', desc: 'Show help' },
    { cmd: '/quit', desc: 'Exit' },
    { cmd: '/tasks', desc: 'Show tasks' },
  ];

  it('renders nothing with empty suggestions', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay suggestions={[]} activeIndex={0} />
    );
    expect(lastFrame()).toBe('');
  });

  it('renders all suggestions', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay suggestions={suggestions} activeIndex={0} />
    );
    expect(lastFrame()).toContain('/help');
    expect(lastFrame()).toContain('/quit');
    expect(lastFrame()).toContain('/tasks');
  });

  it('highlights active suggestion with marker', () => {
    const { lastFrame } = render(
      <SuggestionsDisplay suggestions={suggestions} activeIndex={1} />
    );
    expect(lastFrame()).toContain('▸');
  });
});
