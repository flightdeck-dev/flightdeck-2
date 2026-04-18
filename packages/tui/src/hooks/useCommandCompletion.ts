import { useState, useCallback, useMemo } from 'react';

interface CommandDef {
  cmd: string;
  desc: string;
}

export function useCommandCompletion(input: string, commands: CommandDef[]) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const suggestions = useMemo(() => {
    if (!input.startsWith('/') || input.includes(' ')) return [];
    return commands.filter(c => c.cmd.startsWith(input));
  }, [input, commands]);

  // Reset selection when suggestions change
  const prevLen = useMemo(() => suggestions.length, [suggestions]);

  const complete = useCallback((): string | null => {
    if (suggestions.length === 0) return null;
    const idx = Math.min(selectedIndex, suggestions.length - 1);
    return suggestions[idx].cmd + ' ';
  }, [suggestions, selectedIndex]);

  return {
    suggestions,
    selectedIndex: Math.min(selectedIndex, Math.max(0, suggestions.length - 1)),
    setSelectedIndex,
    complete,
  };
}
