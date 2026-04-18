import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { useInputHistory } from '../hooks/useInputHistory';
import { SuggestionsDisplay } from './SuggestionsDisplay';

interface InputPromptProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  isActive: boolean;
  suggestions?: Array<{ cmd: string; desc: string }>;
  selectedSuggestion?: number;
  onSelectedSuggestionChange?: (index: number) => void;
  onTabComplete?: () => string | null;
  onEnterInputMode?: () => void;
  onExitInputMode?: () => void;
}

export function InputPrompt({
  value,
  onChange,
  onSubmit,
  placeholder = 'Message Lead… (/help for commands)',
  isActive,
  suggestions = [],
  selectedSuggestion = 0,
  onSelectedSuggestionChange,
  onTabComplete,
  onEnterInputMode,
  onExitInputMode,
}: InputPromptProps) {
  const [cursorPos, setCursorPos] = useState(value.length);
  const history = useInputHistory(50);
  const prevActiveRef = useRef(isActive);

  // Sync cursor to end of value when entering input mode or when value changes externally
  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      setCursorPos(value.length);
    }
    prevActiveRef.current = isActive;
  }, [isActive, value.length]);

  const updateValue = useCallback((newVal: string, newCursor?: number) => {
    onChange(newVal);
    setCursorPos(newCursor ?? newVal.length);
  }, [onChange]);

  useInput((ch, key) => {
    if (!isActive) return;

    // Escape: exit input mode
    if (key.escape) {
      onExitInputMode?.();
      return;
    }

    // Tab: complete suggestion
    if (key.tab && suggestions.length > 0) {
      if (onTabComplete) {
        const completed = onTabComplete();
        if (completed) {
          updateValue(completed);
          return;
        }
      }
      return;
    }

    // Up/Down with suggestions: navigate suggestions
    if (key.upArrow && suggestions.length > 0) {
      onSelectedSuggestionChange?.(Math.max(0, selectedSuggestion - 1));
      return;
    }
    if (key.downArrow && suggestions.length > 0) {
      onSelectedSuggestionChange?.(Math.min(suggestions.length - 1, selectedSuggestion + 1));
      return;
    }

    // Up/Down without suggestions: history
    if (key.upArrow) {
      const prev = history.prev();
      if (prev !== undefined) updateValue(prev);
      return;
    }
    if (key.downArrow) {
      const next = history.next();
      if (next !== undefined) updateValue(next);
      return;
    }

    // Enter: submit
    if (key.return) {
      if (value.trim()) {
        history.add(value);
        history.reset();
        onSubmit(value);
      }
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        const newVal = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
        updateValue(newVal, cursorPos - 1);
      }
      return;
    }

    // Left/Right arrow
    if (key.leftArrow) {
      setCursorPos(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorPos(prev => Math.min(value.length, prev + 1));
      return;
    }

    // Home/End (Ctrl+A / Ctrl+E)
    if (key.ctrl && ch === 'a') {
      setCursorPos(0);
      return;
    }
    if (key.ctrl && ch === 'e') {
      setCursorPos(value.length);
      return;
    }

    // Printable character
    if (ch && !key.ctrl && !key.meta) {
      const newVal = value.slice(0, cursorPos) + ch + value.slice(cursorPos);
      updateValue(newVal, cursorPos + ch.length);
    }
  });

  // Render cursor: show block cursor at position
  const renderText = () => {
    if (!value && !isActive) {
      return <Text dimColor>{placeholder}</Text>;
    }
    if (!value) {
      return <Text><Text inverse> </Text><Text dimColor>{placeholder.slice(1)}</Text></Text>;
    }

    const before = value.slice(0, cursorPos);
    const cursor = value[cursorPos] || ' ';
    const after = value.slice(cursorPos + 1);

    return (
      <Text>
        {before}
        {isActive ? <Text inverse>{cursor}</Text> : cursor}
        {after}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <SuggestionsDisplay
          suggestions={suggestions}
          activeIndex={selectedSuggestion}
        />
      )}
      <Box>
        <Text color={isActive ? 'cyan' : 'gray'}>❯ </Text>
        {renderText()}
      </Box>
    </Box>
  );
}
