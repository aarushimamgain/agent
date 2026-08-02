import { Routes, Route, NavLink } from 'react-router-dom';
import WorkflowListPage from './pages/WorkflowListPage.jsx';
import WorkflowDetailPage from './pages/WorkflowDetailPage.jsx';
import RunDetailPage from './pages/RunDetailPage.jsx';
import RunHistoryPage from './pages/RunHistoryPage.jsx';

export default function App() {
  return (
    <>
      <nav className="app-nav">
        <span className="brand">Workflow Platform</span>
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Workflows
        </NavLink>
        <NavLink to="/runs" className={({ isActive }) => (isActive ? 'active' : '')}>
          Run History
        </NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<WorkflowListPage />} />
        <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
        <Route path="/workflows/:workflowId/runs/:runId" element={<RunDetailPage />} />
        <Route path="/runs" element={<RunHistoryPage />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
      </Routes>
    </>
  );
}
