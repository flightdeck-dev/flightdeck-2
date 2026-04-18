import { useState, useCallback, useMemo, useEffect } from 'react';

interface CommandDef {
  cmd: string;
  desc: string;
}

export function useCommandCompletion(
  input: string,
  commands: CommandDef[],
  fetchSubcommands?: (cmd: string) => Promise<CommandDef[]>,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dynamicSuggestions, setDynamicSuggestions] = useState<CommandDef[]>([]);

  // Static slash command suggestions (no space in input)
  const staticSuggestions = useMemo(() => {
    if (!input.startsWith('/') || input.includes(' ')) return [];
    return commands.filter(c => c.cmd.startsWith(input));
  }, [input, commands]);

  // Dynamic sub-command suggestions (e.g. "/project alpha")
  useEffect(() => {
    if (!fetchSubcommands) return;
    const parts = input.split(' ');
    if (parts.length >= 2 && parts[0].startsWith('/')) {
      const baseCmd = parts[0];
      const subInput = parts.slice(1).join(' ');
      fetchSubcommands(baseCmd).then(subs => {
        const filtered = subInput
          ? subs.filter(s => s.cmd.toLowerCase().startsWith(subInput.toLowerCase()))
          : subs;
        setDynamicSuggestions(filtered);
        setSelectedIndex(0);
      }).catch(() => setDynamicSuggestions([]));
    } else {
      setDynamicSuggestions([]);
    }
  }, [input, fetchSubcommands]);

  const suggestions = staticSuggestions.length > 0 ? staticSuggestions : dynamicSuggestions;

  const complete = useCallback((): string | null => {
    if (suggestions.length === 0) return null;
    const idx = Math.min(selectedIndex, suggestions.length - 1);
    const selected = suggestions[idx];
    // For sub-commands, replace only the sub-part
    if (dynamicSuggestions.length > 0) {
      const baseCmd = input.split(' ')[0];
      return `${baseCmd} ${selected.cmd} `;
    }
    return selected.cmd + ' ';
  }, [suggestions, dynamicSuggestions, selectedIndex, input]);

  return {
    suggestions,
    selectedIndex: Math.min(selectedIndex, Math.max(0, suggestions.length - 1)),
    setSelectedIndex,
    complete,
  };
}
