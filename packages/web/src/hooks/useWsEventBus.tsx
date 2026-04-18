import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { wsClient, type WsEvent } from '../lib/ws.ts';

type WsHandler = (event: WsEvent) => void;

interface WsEventBusContextValue {
  subscribe: (handler: WsHandler) => () => void;
  connected: boolean;
}

const WsEventBusCtx = createContext<WsEventBusContextValue | null>(null);

/**
 * Holds the single WebSocket connection and dispatches events to all subscribers.
 */
export function WsEventBusProvider({ projectName, children }: { projectName: string | null; children: ReactNode }) {
  const handlersRef = useRef<Set<WsHandler>>(new Set());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!projectName) return;
    wsClient.setProject(projectName);
    wsClient.connect();

    const unsubConn = wsClient.onConnectionChange((c) => {
      setConnected(c);
    });

    const unsub = wsClient.on((event: WsEvent) => {
      handlersRef.current.forEach(h => h(event));
    });

    return () => {
      unsub();
      unsubConn();
      wsClient.disconnect();
    };
  }, [projectName]);

  const subscribe = useCallback((handler: WsHandler) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  return (
    <WsEventBusCtx.Provider value={{ subscribe, connected }}>
      {children}
    </WsEventBusCtx.Provider>
  );
}

export function useWsEventBus() {
  const ctx = useContext(WsEventBusCtx);
  if (!ctx) throw new Error('useWsEventBus must be inside WsEventBusProvider');
  return ctx;
}
