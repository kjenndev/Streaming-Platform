import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Card } from 'primereact/card';
import { InputText } from 'primereact/inputtext';
import { Password } from 'primereact/password';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import axios from 'axios';
import { API_BASE_URL } from '../config';
import { saveIdentity, safeReturnTarget } from '../session';

const Login = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= retryAt) { clearInterval(timer); setRetryAt(0); }
    }, 250);
    return () => clearInterval(timer);
  }, [retryAt]);
  const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (request.current || Date.now() < retryAt) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const response = await axios.post(`${API_BASE_URL}/api/login`, { username, password }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      saveIdentity(response.data);
      navigate(safeReturnTarget(location.state?.returnTo), { replace: true });
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        const header = String(err.response.headers['retry-after'] || '900');
        const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        setNow(Date.now());
        setRetryAt(Date.now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 900000));
      }
      setError((axios.isAxiosError<{ error: string }>(err) ? err.response?.data?.error : undefined) || 'Login failed');
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  return (
    <div className="flex align-items-center justify-content-center" style={{ height: '100vh', backgroundColor: 'var(--bg)' }}>
      <Card title="Streaming Login" style={{ width: '400px', backgroundColor: 'var(--bg-highlight)', color: 'var(--text)', borderColor: 'var(--base01)' }} className="shadow-4 border-1">
        <form onSubmit={handleLogin} className="flex flex-column align-items-center gap-3">
          <div className="flex flex-column gap-2" style={{ width: '300px' }}>
            <label htmlFor="username" style={{ color: 'var(--text-h)' }}>Username</label>
            <InputText id="username" value={username} onChange={(e) => setUsername(e.target.value)} required style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)', width: '300px' }} />
          </div>
          <div className="flex flex-column gap-2" style={{ width: '300px' }}>
            <label htmlFor="password" style={{ color: 'var(--text-h)' }}>Password</label>
            <Password id="password" value={password} onChange={(e) => setPassword(e.target.value)} feedback={false} toggleMask required style={{ width: '300px' }} inputStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)', width: '300px' }} />
          </div>
          {location.state?.reason === 'session-expired' && <Message severity="warn" text="Your session has expired or is no longer valid. Please sign in again. Unsaved changes have not been submitted." />}
          {retrySeconds > 0 && <Message severity="warn" text={`Try again in ${retrySeconds} second${retrySeconds === 1 ? '' : 's'}.`} />}
          {error && <div style={{ width: '300px' }}><Message severity="error" text={error} className="w-full" /></div>}
          <Button label="Login" icon="pi pi-sign-in" loading={loading} disabled={retrySeconds > 0} type="submit" style={{ backgroundColor: 'var(--blue)', borderColor: 'var(--blue)', width: '300px' }} />
        </form>
      </Card>
    </div>
  );
};

export default Login;
