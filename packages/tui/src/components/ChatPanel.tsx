import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { InputPrompt } from './InputPrompt';
import type { ChatMessage } from '../hooks/useFlightdeck';

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

interface Props {
  messages: ChatMessage[];
  focused: boolean;
  isLeadTyping: boolean;
  streamingText: string;
  input: string;
  onInputChange: (val: string) => void;
  onSubmit: (val: string) => void;
  scrollOffset: number;
  suggestions?: { cmd: string; desc: string }[];
  selectedSuggestion?: number;
  onSelectedSuggestionChange?: (index: number) => void;
  onTabComplete?: () => string | null;
  isInputMode: boolean;
  onEnterInputMode?: () => void;
  onExitInputMode?: () => void;
}

export function ChatPanel({
  messages, focused, isLeadTyping, streamingText,
  input, onInputChange, onSubmit, scrollOffset,
  suggestions = [], selectedSuggestion = 0,
  onSelectedSuggestionChange, onTabComplete,
  isInputMode, onEnterInputMode, onExitInputMode,
}: Props) {
  const [spinIdx, setSpinIdx] = useState(0);

  useEffect(() => {
    if (!isLeadTyping || !streamingText) return;
    const timer = setInterval(() => setSpinIdx(i => (i + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, [isLeadTyping, streamingText]);

  const maxVisible = 12;
  const end = messages.length - scrollOffset;
  const start = Math.max(0, end - maxVisible);
  const visible = messages.slice(start, end > 0 ? end : undefined);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      width="40%"
    >
      <Box paddingX={1}>
        <Text bold color={focused ? 'cyan' : 'white'}>Chat</Text>
        {isLeadTyping && !streamingText && <Text color="yellow"> (Lead typing…)</Text>}
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visible.length === 0 ? (
          <Text dimColor>No messages yet. Type below to chat.</Text>
        ) : (
          visible.map((msg, i) => (
            <Box key={i}>
              <Text dimColor>{msg.time} </Text>
              <Text color={msg.sender === 'user' ? 'white' : 'cyan'} bold>
                {msg.sender === 'user' ? 'you' : msg.sender}
              </Text>
              <Text> {msg.text.slice(0, 80)}</Text>
            </Box>
          ))
        )}
        {isLeadTyping && streamingText && (
          <Box>
            <Text dimColor italic color="yellow">{SPINNER[spinIdx]} {streamingText.slice(-120)}</Text>
          </Box>
        )}
      </Box>
      <Box borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
        <InputPrompt
          value={input}
          onChange={onInputChange}
          onSubmit={onSubmit}
          isActive={isInputMode}
          suggestions={suggestions}
          selectedSuggestion={selectedSuggestion}
          onSelectedSuggestionChange={onSelectedSuggestionChange}
          onTabComplete={onTabComplete}
          onEnterInputMode={onEnterInputMode}
          onExitInputMode={onExitInputMode}
          placeholder={focused ? 'Message Lead… (/help for commands)' : ''}
        />
      </Box>
    </Box>
  );
}
