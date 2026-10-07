import { useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { Menu } from 'primereact/menu';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Password } from 'primereact/password';
import { Message } from 'primereact/message';
import { Toast } from 'primereact/toast';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../config';

const Header = () => {
  const navigate = useNavigate();
  const menu = useRef<Menu>(null);
  const toast = useRef<Toast>(null);
  
  const [displayProfileDialog, setDisplayProfileDialog] = useState(false);
  const [profileForm, setProfileForm] = useState({ username: localStorage.getItem('username') || '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const username = localStorage.getItem('username') || 'User';
  const rolesStr = localStorage.getItem('roles');
  let roles: string[] = [];
  if (rolesStr) {
    try {
      roles = JSON.parse(rolesStr);
    } catch {
      roles = [];
    }
  }

  // Fallback for sessions that haven't re-logged since the multi-role update
  if (roles.length === 0) {
    const oldRole = localStorage.getItem('role');
    if (oldRole) roles = [oldRole];
  }

  const normalizedRoles = roles.map(r => r.toUpperCase());
  const isAdmin = normalizedRoles.includes('ADMIN');
  const token = localStorage.getItem('token');

  const handleUpdateProfile = async () => {
    if (!profileForm.username) {
      setError('Username is required');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const response = await axios.put(`${API_BASE_URL}/api/profile`, profileForm, {
        headers: { Authorization: `Bearer ${token}` }
      });
      localStorage.setItem('username', response.data.username);
      toast.current?.show({ severity: 'success', summary: 'Updated', detail: 'Profile updated successfully', life: 3000 });
      setTimeout(() => {
        setDisplayProfileDialog(false);
        window.location.reload();
      }, 1000);
    } catch (err: unknown) {
      setError((axios.isAxiosError<{ error: string }>(err) ? err.response?.data?.error : undefined) || 'Failed to update profile');
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to update profile', life: 3000 });
    } finally {
      setLoading(false);
    }
  };

  const items = [
    {
      label: 'Manage Account',
      icon: 'pi pi-user-edit',
      command: () => {
        setProfileForm({ username: localStorage.getItem('username') || '', password: '' });
        setDisplayProfileDialog(true);
      }
    },
    ...(isAdmin ? [{
      label: 'Manage Users',
      icon: 'pi pi-users',
      command: () => navigate('/users')
    }, {
      label: 'App Settings',
      icon: 'pi pi-cog',
      command: () => navigate('/settings')
    }] : []),
    {
      label: 'Logout',
      icon: 'pi pi-sign-out',
      command: () => {
        localStorage.clear();
        navigate('/login');
      }
    }
  ];

  return (
    <>
      <Toast ref={toast} />
      <div className="p-3 border-bottom-1 flex justify-content-between align-items-center shadow-1" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}>
        <h1 className="m-0 text-2xl font-bold cursor-pointer" style={{ color: 'var(--blue)' }} onClick={() => navigate('/dashboard')}>Streaming Platform</h1>
        
        <div className="flex align-items-center">
          <Menu model={items} popup ref={menu} id="popup_menu" />
          <Button 
            label={username} 
            icon="pi pi-user" 
            className="p-button-text text-white p-button-sm font-bold" 
            onClick={(event) => menu.current?.toggle(event)} 
            aria-controls="popup_menu" 
            aria-haspopup 
          />
        </div>
      </div>

      <Dialog header="Manage Account" visible={displayProfileDialog} style={{ width: '450px' }} onHide={() => setDisplayProfileDialog(false)}
        footer={<div>
          <Button label="Cancel" icon="pi pi-times" onClick={() => setDisplayProfileDialog(false)} className="p-button-text" />
          <Button label="Save Changes" icon="pi pi-check" onClick={handleUpdateProfile} loading={loading} autoFocus />
        </div>}>
        <div className="flex flex-column align-items-center gap-3 mt-2">
          <div className="flex flex-column gap-2" style={{ width: '300px' }}>
            <label className="text-sm font-bold" style={{ color: 'var(--text-h)' }}>Username</label>
            <InputText value={profileForm.username} onChange={(e) => setProfileForm({ ...profileForm, username: e.target.value })} style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)', width: '300px' }} />
          </div>
          <div className="flex flex-column gap-2" style={{ width: '300px' }}>
            <div className="flex justify-content-between align-items-center">
              <label className="text-sm font-bold" style={{ color: 'var(--text-h)' }}>New Password</label>
              <small style={{ color: 'var(--base01)' }}>(Optional)</small>
            </div>
            <Password value={profileForm.password} onChange={(e) => setProfileForm({ ...profileForm, password: e.target.value })} feedback={false} toggleMask inputStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)', width: '300px' }} style={{ width: '300px' }} placeholder="Leave blank to keep current" />
          </div>
          {error && <Message severity="error" text={error} />}
        </div>
      </Dialog>
    </>
  );
};

export default Header;
