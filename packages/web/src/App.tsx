import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import Dashboard from './pages/Dashboard.tsx';
import Tasks from './pages/Tasks.tsx';
import Agents from './pages/Agents.tsx';
import Specs from './pages/Specs.tsx';
import Decisions from './pages/Decisions.tsx';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="agents" element={<Agents />} />
          <Route path="specs" element={<Specs />} />
          <Route path="decisions" element={<Decisions />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
