import { Fragment, useSyncExternalStore, type ReactElement } from 'react';
import { sessionToken, subscribeSession, sessionExpired } from './session';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Player from './pages/Player';
import UserManagement from './pages/UserManagement';
import AppSettings from './pages/AppSettings';
import SharePlayer from './pages/SharePlayer';
import MssManager from './pages/MssManager';
import StreamEditor from './pages/StreamEditor';
import { ConfirmDialog } from 'primereact/confirmdialog';

const ProtectedRoute = ({ children }: { children: ReactElement }) => {
  const token = useSyncExternalStore(subscribeSession, sessionToken);
  const location = useLocation();
  if (!token) {
    return <Navigate to="/login" replace state={{ returnTo: location.pathname + location.search + location.hash, reason: sessionExpired() ? 'session-expired' : undefined }} />;
  }
  return <Fragment key={token}>{children}</Fragment>;
};

function App() {
  return (
    <Router>
      <ConfirmDialog />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route 
          path="/dashboard" 
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/users" 
          element={
            <ProtectedRoute>
              <UserManagement />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/settings" 
          element={
            <ProtectedRoute>
              <AppSettings />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/dashboard/stream/:id?" 
          element={
            <ProtectedRoute>
              <StreamEditor />
            </ProtectedRoute>
          } 
        />
        <Route path="/embed/:channelName" element={<Player videoOnly />} />
        <Route path="/mss-manager" element={<MssManager />} />
        <Route path="/watch/:channelName" element={<Player />} />
        <Route path="/share/:id" element={<SharePlayer />} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
