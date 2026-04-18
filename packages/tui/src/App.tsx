import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { useFlightdeck } from './hooks/useFlightdeck';
import { StatusBar } from './components/StatusBar';
import { TaskList } from './components/TaskList';
import { ChatPanel } from './components/ChatPanel';
import { ActivityFeed } from './components/ActivityFeed';
import { AgentPanel } from './components/AgentPanel';
import { HelpBar } from './components/HelpBar';
import { AgentOverlay } from './components/AgentOverlay';
import { TaskOverlay } from './components/TaskOverlay';
import { DISPLAY_PRESET_NAMES } from '@flightdeck-ai/shared/display';
import type { DisplayPreset, ToolVisibility } from '@flightdeck-ai/shared/display';

const COMMANDS = [
  { cmd: '/help', desc: 'Show all commands' },
  { cmd: '/quit', desc: 'Exit Flightdeck TUI' },
  { cmd: '/agents', desc: 'Full-screen agent dashboard' },
  { cmd: '/tasks', desc: 'Full-screen task dashboard' },
  { cmd: '/projects', desc: 'List all projects' },
  { cmd: '/project', desc: 'Switch project: /project <name>' },
  { cmd: '/status', desc: 'Project status' },
  { cmd: '/report', desc: 'Daily report' },
  { cmd: '/models', desc: 'Available models' },
  { cmd: '/model', desc: 'Set agent model: /model <id> <model>' },
  { cmd: '/hibernate', desc: 'Hibernate agent: /hibernate <id>' },
  { cmd: '/wake', desc: 'Wake agent: /wake <id>' },
  { cmd: '/retire', desc: 'Retire agent: /retire <id>' },
  { cmd: '/interrupt', desc: 'Interrupt agent: /interrupt <id> [msg]' },
  { cmd: '/display', desc: 'Display config: /display [preset]' },
];

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
  const [overlay, setOverlay] = useState<'agents' | 'tasks' | null>(null);
  const [suggestions, setSuggestions] = useState<typeof COMMANDS>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);

  // Mouse scroll support: enable SGR mouse tracking
  useEffect(() => {
    const enable = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
    const disable = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
    process.stdout.write(enable);

    const onData = (data: Buffer) => {
      const str = data.toString();
      // Parse SGR mouse sequences: \x1b[<btn;col;rowM
      const match = str.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
      if (!match) return;
      const btn = parseInt(match[1], 10);
      if (btn === 64) {
        // wheel up
        if (focusedPanel === 'tasks') {
          setTaskIndex(prev => Math.max(0, prev - 1));
        } else if (focusedPanel === 'center') {
          if (centerTab === 'chat') setChatScroll(prev => prev + 1);
          else setActivityScroll(prev => prev + 1);
        }
      } else if (btn === 65) {
        // wheel down
        if (focusedPanel === 'tasks') {
          setTaskIndex(prev => Math.min(prev + 1, fd.tasks.length - 1));
        } else if (focusedPanel === 'center') {
          if (centerTab === 'chat') setChatScroll(prev => Math.max(0, prev - 1));
          else setActivityScroll(prev => Math.max(0, prev - 1));
        }
      }
    };

    process.stdin.on('data', onData);
    return () => {
      process.stdout.write(disable);
      process.stdin.removeListener('data', onData);
    };
  }, [focusedPanel, centerTab, fd.tasks.length]);

  const panels: Panel[] = ['tasks', 'center', 'agents'];

  useInput((ch, key) => {
    // Overlay handles its own input
    if (overlay) return;

    // When typing in chat input, don't intercept
    if (isInputMode) {
      if (key.escape) {
        setIsInputMode(false);
        setSuggestions([]);
        setSelectedSuggestion(0);
      } else if (key.tab && suggestions.length > 0) {
        const selected = suggestions[selectedSuggestion];
        if (selected) {
          setInput(selected.cmd + ' ');
          setSuggestions([]);
          setSelectedSuggestion(0);
        }
      } else if (key.upArrow && suggestions.length > 0) {
        setSelectedSuggestion(prev => Math.max(0, prev - 1));
      } else if (key.downArrow && suggestions.length > 0) {
        setSelectedSuggestion(prev => Math.min(suggestions.length - 1, prev + 1));
      }
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
    if (key.leftArrow) {
      setFocusedPanel(prev => {
        const idx = panels.indexOf(prev);
        return panels[(idx - 1 + panels.length) % panels.length];
      });
      return;
    }
    if (key.rightArrow) {
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
    if (ch === 'j' || ch === 'k' || key.downArrow || key.upArrow) {
      const delta = (ch === 'j' || key.downArrow) ? 1 : -1;
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
        if (centerTab === 'chat') setChatScroll(prev => Math.max(0, prev + (ch === 'k' || key.upArrow ? 1 : -1)));
        else setActivityScroll(prev => Math.max(0, prev + (ch === 'k' || key.upArrow ? 1 : -1)));
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
            '/hibernate|wake|retire <id> — Agent lifecycle  /interrupt <id> [msg]',
            '/model <id> <model> — Set model  /model list — Available models',
            '/projects — List projects  /project <name> — Switch project',
          ]);
          return;
        case '/tasks': {
          setOverlay('tasks');
          return;
        }
        case '/agents': {
          setOverlay('agents');
          return;
        }
        case '/hibernate': case '/wake': case '/retire': {
          const agentId = args[0];
          if (!agentId) { setCmdOutput([`Usage: ${cmd} <agentId>`]); return; }
          const action = cmd.slice(1); // hibernate, wake, retire
          try {
            const res = await fetch(`${fd.baseUrl}/api/projects/${fd.project}/agents/${agentId}/${action}`, { method: 'POST' });
            setCmdOutput([res.ok ? `Agent ${agentId}: ${action} OK` : `Failed: ${res.status} ${res.statusText}`]);
          } catch (e: any) { setCmdOutput([`Error: ${e.message}`]); }
          return;
        }
        case '/interrupt': {
          const agentId = args[0];
          if (!agentId) { setCmdOutput(['Usage: /interrupt <agentId> [message]']); return; }
          const message = args.slice(1).join(' ') || '';
          try {
            const res = await fetch(`${fd.baseUrl}/api/projects/${fd.project}/agents/${agentId}/interrupt`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
            });
            setCmdOutput([res.ok ? `Interrupted ${agentId}` : `Failed: ${res.status}`]);
          } catch (e: any) { setCmdOutput([`Error: ${e.message}`]); }
          return;
        }
        case '/model': {
          if (args[0] === 'list') {
            const data = await fd.fetchJson(`/api/projects/${fd.project}/models/available`);
            if (!data) { setCmdOutput(['Failed to fetch models']); return; }
            const lines: string[] = [];
            for (const [runtime, models] of Object.entries(data)) {
              lines.push(`  ${runtime}:`);
              if (Array.isArray(models)) models.forEach((m: any) => lines.push(`    ${typeof m === 'string' ? m : m.id || m.name}`));
            }
            setCmdOutput(lines.length ? lines : ['No models available']);
            return;
          }
          const [agentId, ...modelParts] = args;
          const model = modelParts.join(' ');
          if (!agentId || !model) { setCmdOutput(['Usage: /model <agentId> <model> or /model list']); return; }
          try {
            const res = await fetch(`${fd.baseUrl}/api/projects/${fd.project}/agents/${agentId}/model`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
            });
            setCmdOutput([res.ok ? `Agent ${agentId} model → ${model}` : `Failed: ${res.status}`]);
          } catch (e: any) { setCmdOutput([`Error: ${e.message}`]); }
          return;
        }
        case '/projects':
        case '/project': {
          const sub = args[0];
          if (!sub || sub === 'list') {
            const projects = await fd.fetchJson('/api/projects');
            if (!projects || !Array.isArray(projects)) { setCmdOutput(['Failed to fetch projects']); return; }
            setCmdOutput(projects.map((p: any) => {
              const agents = p.agentCount ?? p.agents?.length ?? '?';
              const tasks = p.taskStats ? `${p.taskStats.done || 0}/${p.taskStats.total || 0} done` : '';
              return `  ${(p.name || p.id || '?').padEnd(20)} ${(p.governance || '').padEnd(12)} ${String(agents).padEnd(4)} agents  ${tasks}`;
            }));
            return;
          }
          const name = sub === 'switch' ? args[1] : sub;
          if (!name) { setCmdOutput(['Usage: /project switch <name> or /project <name>']); return; }
          fd.switchProject(name);
          setCmdOutput([`Switched to project: ${name}`]);
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

  // Update suggestions when input changes
  const handleInputChange = useCallback((val: string) => {
    setInput(val);
    if (val.startsWith('/') && !val.includes(' ')) {
      const matches = COMMANDS.filter(c => c.cmd.startsWith(val));
      setSuggestions(matches);
      setSelectedSuggestion(0);
    } else {
      setSuggestions([]);
      setSelectedSuggestion(0);
    }
  }, []);

  if (overlay === 'agents') {
    return (
      <Box flexDirection="column" width="100%">
        <AgentOverlay
          agents={fd.agents}
          baseUrl={fd.baseUrl}
          project={fd.project}
          onClose={() => setOverlay(null)}
        />
      </Box>
    );
  }

  if (overlay === 'tasks') {
    return (
      <Box flexDirection="column" width="100%">
        <TaskOverlay
          tasks={fd.tasks}
          onClose={() => setOverlay(null)}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <StatusBar
        status={fd.status}
        counts={fd.taskCounts}
        agentCount={fd.agents.length}
        agentSummary={{
          busy: fd.agents.filter(a => a.status === 'busy' || a.status === 'active').length,
          idle: fd.agents.filter(a => a.status === 'idle').length,
          total: fd.agents.length,
        }}
      />

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
            streamingText={fd.streamingText}
            input={input}
            onInputChange={handleInputChange}
            suggestions={suggestions}
            selectedSuggestion={selectedSuggestion}
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
