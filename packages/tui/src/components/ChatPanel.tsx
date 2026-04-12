import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { ChatMessage } from '../hooks/useFlightdeck';

interface Props {
  messages: ChatMessage[];
  focused: boolean;
  isLeadTyping: boolean;
  input: string;
  onInputChange: (val: string) => void;
  onSubmit: (val: string) => void;
  scrollOffset: number;
}

export function ChatPanel({ messages, focused, isLeadTyping, input, onInputChange, onSubmit, scrollOffset }: Props) {
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
        {isLeadTyping && <Text color="yellow"> (Lead typing…)</Text>}
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
      </Box>
      <Box borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={focused ? 'cyan' : 'gray'}>❯ </Text>
        <TextInput
          value={input}
          onChange={onInputChange}
          onSubmit={onSubmit}
          placeholder={focused ? 'Message Lead… (/help for commands)' : ''}
        />
      </Box>
    </Box>
  );
}
