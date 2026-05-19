import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Player from './pages/Player';
import UserManagement from './pages/UserManagement';
import AppSettings from './pages/AppSettings';
import SharePlayer from './pages/SharePlayer';
import StreamEditor from './pages/StreamEditor';
import { ConfirmDialog } from 'primereact/confirmdialog';

const ProtectedRoute = ({ children }: { children: JSX.Element }) => {
  const token = localStorage.getItem('token');
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children;
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
        <Route path="/watch/:channelName" element={<Player />} />
        <Route path="/share/:id" element={<SharePlayer />} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
