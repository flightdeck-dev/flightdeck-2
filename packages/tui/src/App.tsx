import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { useFlightdeck } from './hooks/useFlightdeck';
import { StatusBar } from './components/StatusBar';
import { TaskList } from './components/TaskList';
import { ChatPanel } from './components/ChatPanel';
import { ActivityFeed } from './components/ActivityFeed';
import { AgentPanel } from './components/AgentPanel';
import { HelpBar } from './components/HelpBar';
import { DISPLAY_PRESET_NAMES } from '@flightdeck-ai/shared/display';
import type { DisplayPreset, ToolVisibility } from '@flightdeck-ai/shared/display';

type Panel = 'tasks' | 'center' | 'agents';

interface AppProps {
  baseUrl: string;
  wsUrl: string;
}

export function App({ baseUrl, wsUrl }: AppProps) {
  const fd = useFlightdeck(baseUrl, wsUrl);
  const { exit } = useApp();

  const [focusedPanel, setFocusedPanel] = useState<Panel>('center');
  const [centerTab, setCenterTab] = useState<'chat' | 'activity'>('chat');
  const [input, setInput] = useState('');
  const [taskIndex, setTaskIndex] = useState(0);
  const [taskScroll, setTaskScroll] = useState(0);
  const [agentIndex, setAgentIndex] = useState(0);
  const [chatScroll, setChatScroll] = useState(0);
  const [activityScroll, setActivityScroll] = useState(0);
  const [cmdOutput, setCmdOutput] = useState<string[]>([]);
  const [isInputMode, setIsInputMode] = useState(false);

  const panels: Panel[] = ['tasks', 'center', 'agents'];

  useInput((ch, key) => {
    // When typing in chat input, don't intercept
    if (isInputMode) {
      if (key.escape) setIsInputMode(false);
      return;
    }

    // Tab: cycle panels
    if (key.tab) {
      setFocusedPanel(prev => {
        const idx = panels.indexOf(prev);
        return panels[(idx + 1) % panels.length];
      });
      return;
    }

    // Quick panel switches
    if (ch === 't') { setFocusedPanel('tasks'); return; }
    if (ch === 'c') { setFocusedPanel('center'); setCenterTab('chat'); return; }
    if (ch === 'a') { setFocusedPanel('agents'); return; }
    if (ch === 'q') { exit(); return; }

    // Toggle center tab
    if (key.ctrl && ch === 't') {
      setCenterTab(prev => prev === 'chat' ? 'activity' : 'chat');
      return;
    }

    // Enter input mode when / or Enter in center
    if (ch === '/' || (key.return && focusedPanel === 'center')) {
      setIsInputMode(true);
      if (ch === '/') setInput('/');
      return;
    }

    // j/k scrolling
    if (ch === 'j' || ch === 'k') {
      const delta = ch === 'j' ? 1 : -1;
      if (focusedPanel === 'tasks') {
        setTaskIndex(prev => Math.max(0, Math.min(prev + delta, fd.tasks.length - 1)));
        // Auto-scroll
        setTaskScroll(prev => {
          const newIdx = Math.max(0, Math.min(taskIndex + delta, fd.tasks.length - 1));
          if (newIdx < prev) return newIdx;
          if (newIdx >= prev + 15) return newIdx - 14;
          return prev;
        });
      } else if (focusedPanel === 'center') {
        if (centerTab === 'chat') setChatScroll(prev => Math.max(0, prev + (ch === 'k' ? 1 : -1)));
        else setActivityScroll(prev => Math.max(0, prev + (ch === 'k' ? 1 : -1)));
      } else if (focusedPanel === 'agents') {
        setAgentIndex(prev => Math.max(0, Math.min(prev + delta, fd.agents.length - 1)));
      }
    }
  });

  const handleSubmit = useCallback(async (text: string) => {
    setInput('');
    setIsInputMode(false);
    setCmdOutput([]);
    if (!text.trim()) return;

    if (text.startsWith('/')) {
      const [cmd, ...args] = text.trim().split(/\s+/);
      switch (cmd) {
        case '/quit': exit(); return;
        case '/help':
          setCmdOutput([
            '/tasks — List tasks  /agents — List agents  /report — Daily report',
            '/status — Project status  /display [preset] — Display config  /quit — Exit',
          ]);
          return;
        case '/tasks': {
          const tasks = await fd.fetchJson('/api/tasks');
          if (!tasks || !Array.isArray(tasks)) { setCmdOutput(['Failed to fetch tasks']); return; }
          setCmdOutput(tasks.map((t: any) => `  ${t.status.padEnd(10)} ${t.title || t.id}`).slice(0, 20));
          return;
        }
        case '/agents': {
          const agents = await fd.fetchJson('/api/agents');
          if (!agents || !Array.isArray(agents)) { setCmdOutput(['Failed to fetch agents']); return; }
          setCmdOutput(agents.map((a: any) => `  ${a.status.padEnd(8)} ${a.role} — ${a.model || '?'}`));
          return;
        }
        case '/display': {
          const sub = args[0];
          if (!sub) {
            setCmdOutput([`thinking: ${fd.displayConfig.thinking ? 'on' : 'off'}, tools: ${fd.displayConfig.toolCalls}, presets: ${DISPLAY_PRESET_NAMES.join('|')}`]);
            return;
          }
          if (DISPLAY_PRESET_NAMES.includes(sub as any)) {
            fd.applyPreset(sub as DisplayPreset);
            setCmdOutput([`Preset: ${sub}`]);
            return;
          }
          if (sub === 'thinking') {
            fd.sendDisplayUpdate({ thinking: args[1] === 'on' });
            setCmdOutput([`Thinking: ${args[1] || 'off'}`]);
            return;
          }
          if (sub === 'tools') {
            fd.sendDisplayUpdate({ toolCalls: (args[1] || 'summary') as ToolVisibility });
            setCmdOutput([`Tools: ${args[1] || 'summary'}`]);
            return;
          }
          setCmdOutput(['Usage: /display [preset|thinking|tools] [value]']);
          return;
        }
        case '/report': case '/status': case '/models': {
          const path = cmd === '/report' ? '/api/report' : cmd === '/models' ? '/api/models' : '/api/status';
          const data = await fd.fetchJson(path);
          setCmdOutput(data ? (typeof data === 'string' ? [data] : Object.entries(data).map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)) : ['Failed']);
          return;
        }
        default:
          setCmdOutput([`Unknown: ${cmd} — /help for commands`]);
          return;
      }
    }

    fd.sendMessage(text);
  }, [exit, fd]);

  return (
    <Box flexDirection="column" width="100%">
      <StatusBar status={fd.status} counts={fd.taskCounts} agentCount={fd.agents.length} />

      {/* Three-column layout */}
      <Box flexGrow={1} height={20}>
        <TaskList
          tasks={fd.tasks}
          selectedIndex={taskIndex}
          scrollOffset={taskScroll}
          focused={focusedPanel === 'tasks'}
          maxHeight={20}
        />

        {centerTab === 'chat' ? (
          <ChatPanel
            messages={fd.chatMessages}
            focused={focusedPanel === 'center'}
            isLeadTyping={fd.isLeadTyping}
            input={input}
            onInputChange={setInput}
            onSubmit={handleSubmit}
            scrollOffset={chatScroll}
          />
        ) : (
          <ActivityFeed
            items={fd.activities}
            focused={focusedPanel === 'center'}
            scrollOffset={activityScroll}
          />
        )}

        <AgentPanel
          agents={fd.agents}
          focused={focusedPanel === 'agents'}
          selectedIndex={agentIndex}
        />
      </Box>

      {/* Command output overlay */}
      {cmdOutput.length > 0 && (
        <Box flexDirection="column" paddingX={2} borderStyle="single" borderColor="yellow">
          {cmdOutput.map((line, i) => <Box key={i}><Text>{line}</Text></Box>)}
        </Box>
      )}

      <HelpBar focusedPanel={focusedPanel} centerTab={centerTab} />
    </Box>
  );
}
