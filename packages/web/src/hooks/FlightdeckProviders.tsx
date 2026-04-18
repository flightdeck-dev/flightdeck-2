import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { WsEventBusProvider } from './useWsEventBus.tsx';
import { DisplayProvider } from './useDisplay.tsx';
import { ProjectProvider } from './useProject.tsx';
import { TaskProvider } from './useTasks.tsx';
import { AgentProvider } from './useAgents.tsx';
import { ChatProvider } from './useChat.tsx';

const swrConfig = {
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  dedupingInterval: 2000,
  errorRetryCount: 3,
};

export function FlightdeckProviders({ projectName, children }: { projectName: string | null; children: ReactNode }) {
  return (
    <SWRConfig value={swrConfig}>
      <WsEventBusProvider projectName={projectName}>
        <DisplayProvider>
          <ProjectProvider projectName={projectName}>
            <TaskProvider>
              <AgentProvider>
                <ChatProvider>
                  {children}
                </ChatProvider>
              </AgentProvider>
            </TaskProvider>
          </ProjectProvider>
        </DisplayProvider>
      </WsEventBusProvider>
    </SWRConfig>
  );
}
