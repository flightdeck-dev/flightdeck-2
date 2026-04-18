import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { type DisplayConfig, type DisplayPreset, DEFAULT_DISPLAY, DISPLAY_PRESETS } from '@flightdeck-ai/shared/display';
import { wsClient } from '../lib/ws.ts';
import { useWsEventBus } from './useWsEventBus.tsx';

const STORAGE_KEY = 'flightdeck:display';
const STORAGE_VERSION = 1;
const STORAGE_VERSION_KEY = 'flightdeck:display:version';

function loadDisplayConfig(): DisplayConfig {
  try {
    const ver = localStorage.getItem(STORAGE_VERSION_KEY);
    if (ver !== String(STORAGE_VERSION)) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION));
      return { ...DEFAULT_DISPLAY };
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : { ...DEFAULT_DISPLAY };
  } catch { return { ...DEFAULT_DISPLAY }; }
}

function saveDisplayConfig(config: DisplayConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION));
  } catch {}
}

export interface DisplayContextValue {
  displayConfig: DisplayConfig;
  setDisplayConfig: (config: Partial<DisplayConfig>) => void;
  applyDisplayPreset: (preset: DisplayPreset) => void;
}

const DisplayCtx = createContext<DisplayContextValue | null>(null);

export function DisplayProvider({ children }: { children: ReactNode }) {
  const [displayConfig, setDisplayConfigState] = useState<DisplayConfig>(loadDisplayConfig);
  const { subscribe, connected } = useWsEventBus();

  // Push saved config on connect
  useEffect(() => {
    if (connected) {
      wsClient.sendDisplayConfig(loadDisplayConfig());
    }
  }, [connected]);

  // Listen for display:config from server
  useEffect(() => {
    let ignoreFirst = true;
    return subscribe((event) => {
      if (event.type === 'display:config') {
        if (ignoreFirst) { ignoreFirst = false; return; }
        setDisplayConfigState(event.config);
        saveDisplayConfig(event.config);
      }
    });
  }, [subscribe]);

  const setDisplayConfig = useCallback((config: Partial<DisplayConfig>) => {
    wsClient.sendDisplayConfig(config);
    setDisplayConfigState(prev => {
      const merged = { ...prev, ...config };
      saveDisplayConfig(merged);
      return merged;
    });
  }, []);

  const applyDisplayPreset = useCallback((preset: DisplayPreset) => {
    const config = DISPLAY_PRESETS[preset];
    setDisplayConfig({ ...config });
  }, [setDisplayConfig]);

  return (
    <DisplayCtx.Provider value={{ displayConfig, setDisplayConfig, applyDisplayPreset }}>
      {children}
    </DisplayCtx.Provider>
  );
}

export function useDisplay(): DisplayContextValue {
  const ctx = useContext(DisplayCtx);
  if (!ctx) throw new Error('useDisplay must be inside DisplayProvider');
  return ctx;
}
