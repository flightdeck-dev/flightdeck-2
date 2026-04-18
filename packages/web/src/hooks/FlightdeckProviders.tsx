import type { ReactNode } from 'react';
import { WsEventBusProvider } from './useWsEventBus.tsx';
import { DisplayProvider } from './useDisplay.tsx';
import { ProjectProvider } from './useProject.tsx';
import { TaskProvider } from './useTasks.tsx';
import { AgentProvider } from './useAgents.tsx';
import { ChatProvider } from './useChat.tsx';

export function FlightdeckProviders({ projectName, children }: { projectName: string | null; children: ReactNode }) {
  return (
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
  );
}
