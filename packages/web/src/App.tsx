import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import { FlightdeckProvider } from './hooks/useFlightdeck.tsx';
import Dashboard from './pages/Dashboard.tsx';
import Chat from './pages/Chat.tsx';
import Tasks from './pages/Tasks.tsx';
import Agents from './pages/Agents.tsx';
import Specs from './pages/Specs.tsx';
import Decisions from './pages/Decisions.tsx';

export function App() {
  return (
    <FlightdeckProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="chat" element={<Chat />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="agents" element={<Agents />} />
            <Route path="specs" element={<Specs />} />
            <Route path="decisions" element={<Decisions />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </FlightdeckProvider>
  );
}
