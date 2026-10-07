import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from 'primereact/card';
import { InputText } from 'primereact/inputtext';
import { Password } from 'primereact/password';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import axios from 'axios';
import { API_BASE_URL } from '../config';

const Login = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await axios.post(`${API_BASE_URL}/api/login`, { username, password });
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('username', response.data.username);
      localStorage.setItem('roles', JSON.stringify(response.data.roles || []));
      navigate('/dashboard');
    } catch (err: unknown) {
      setError((axios.isAxiosError<{ error: string }>(err) ? err.response?.data?.error : undefined) || 'Login failed');
    } finally {
      setLoading(false);
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
          {error && <div style={{ width: '300px' }}><Message severity="error" text={error} className="w-full" /></div>}
          <Button label="Login" icon="pi pi-sign-in" loading={loading} type="submit" style={{ backgroundColor: 'var(--blue)', borderColor: 'var(--blue)', width: '300px' }} />
        </form>
      </Card>
    </div>
  );
};

export default Login;
