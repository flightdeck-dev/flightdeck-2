import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

interface ProjectSelectProps {
  baseUrl: string;
  onSelect: (name: string) => void;
}

export function ProjectSelect({ baseUrl, onSelect }: ProjectSelectProps) {
  const [projects, setProjects] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${baseUrl}/api/projects`)
      .then(r => r.json())
      .then(data => {
        const list = data?.projects ?? data ?? [];
        const names = list.map((p: any) => typeof p === 'string' ? p : p.name);
        setProjects(names);
        if (names.length === 1) onSelect(names[0]);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [baseUrl]);

  useInput((_, key) => {
    if (key.downArrow) setSelected(i => Math.min(i + 1, projects.length - 1));
    if (key.upArrow) setSelected(i => Math.max(i - 1, 0));
    if (key.return && projects.length > 0) onSelect(projects[selected]);
  });

  if (loading) {
    return <Box padding={1}><Text color="blue">Loading projects...</Text></Box>;
  }

  if (error) {
    return <Box padding={1}><Text color="red">Error: {error}</Text></Box>;
  }

  if (projects.length === 0) {
    return <Box padding={1}><Text color="yellow">No projects found. Start a project first.</Text></Box>;
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="blue">Select a project:</Text>
      <Text> </Text>
      {projects.map((name, i) => (
        <Text key={name} color={i === selected ? 'green' : 'white'}>
          {i === selected ? '▸ ' : '  '}{name}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>↑/↓ to navigate, Enter to select</Text>
    </Box>
  );
}
