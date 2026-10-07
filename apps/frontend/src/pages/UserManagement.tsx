import { fetchStreamCatalog } from '../pagination';
import type { Stream, User, StreamOption } from '../models';
import type { DataTableExpandedRows } from 'primereact/datatable';
import React, { useState, useCallback, useEffect } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Password } from 'primereact/password';
import { Message } from 'primereact/message';
import { MultiSelect } from 'primereact/multiselect';
import { Toast } from 'primereact/toast';
import { confirmDialog } from 'primereact/confirmdialog';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import Header from '../components/Header';
import { API_BASE_URL } from '../config';

// Sub-component for the expanded row to safely use hooks
const UserStreamPermissions = ({ user, availableStreams, onSave }: { user: User; availableStreams: StreamOption[]; onSave: (user: User, ids: string[]) => void }) => {
  const [selectedIds, setSelectedIds] = useState(user.authorizedStreams ? user.authorizedStreams.map((s: Stream) => s.id) : []);

  const toggleStream = (streamId: string) => {
    const _selectedIds = [...selectedIds];
    const index = _selectedIds.indexOf(streamId);
    if (index === -1)
      _selectedIds.push(streamId);
    else
      _selectedIds.splice(index, 1);
    setSelectedIds(_selectedIds);
  };

  if (user.roles && user.roles.includes('ADMIN')) {
    return (
      <div className="p-3 surface-100 border-round m-2" style={{ backgroundColor: 'var(--base02)' }}>
        <p className="m-0 font-bold" style={{ color: 'var(--base1)' }}>Administrators have access to all streams by default.</p>
      </div>
    );
  }

  return (
    <div className="p-4 border-round m-2" style={{ backgroundColor: 'var(--bg-highlight)', border: '1px solid var(--base01)' }}>
      <h3 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--blue)' }}>Stream Access Permissions</h3>
      <div className="flex flex-column gap-3">
        <div className="flex flex-column gap-2">
          <label className="text-xs font-bold mb-2" style={{ color: 'var(--base01)' }}>Authorize Specific Streams</label>
          <div className="flex flex-wrap gap-2">
            {availableStreams.length === 0 ? (
              <div className="italic text-sm" style={{ color: 'var(--base01)' }}>No streams configured.</div>
            ) : (
              availableStreams.map((stream: StreamOption) => {
                const isSelected = selectedIds.includes(stream.value);
                return (
                  <div 
                    key={stream.value} 
                    onClick={() => toggleStream(stream.value)}
                    className="flex align-items-center gap-3 p-2 border-round border-1 cursor-pointer select-none transition-colors duration-200" 
                    style={{ 
                      backgroundColor: isSelected ? 'var(--base02)' : 'var(--bg)', 
                      borderColor: isSelected ? 'var(--blue)' : 'var(--base01)',
                    }}
                  >
                    <span className="text-sm font-bold" style={{ color: isSelected ? 'var(--blue)' : 'var(--text)' }}>
                      {stream.label}
                    </span>
                    <i className={`pi ${isSelected ? 'pi-check-circle' : 'pi-circle'} text-sm`} 
                       style={{ color: isSelected ? 'var(--blue)' : 'var(--base01)' }}></i>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className="flex justify-content-end border-top-1 pt-3" style={{ borderColor: 'var(--base01)' }}>
          <Button 
            label="Save Permissions" 
            icon="pi pi-save" 
            className="p-button-sm" 
            onClick={() => onSave(user, selectedIds)} 
          />
        </div>
      </div>
    </div>
  );
};

const UserManagement = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [availableStreams, setAvailableStreams] = useState<StreamOption[]>([]);
  const [displayDialog, setDisplayDialog] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [expandedRows, setExpandedRows] = useState<DataTableExpandedRows | User[] | null>(null);
  const [userForm, setUserForm] = useState<{ username: string; password: string; roles: string[]; authorizedStreamIds: string[] }>({
    username: '', 
    password: '', 
    roles: ['STREAM_MANAGER'],
    authorizedStreamIds: []
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  const toast = React.useRef<Toast>(null);
  const token = localStorage.getItem('token');
  const navigate = useNavigate();

  const fetchUsers = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setUsers(response.data);
    } catch {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to fetch users', life: 3000 });
    }
  }, [token]);

  const fetchStreams = useCallback(async () => {
    try {
      const catalog = await fetchStreamCatalog<Stream>(`${API_BASE_URL}/api/streams`, token);
      setAvailableStreams(catalog.map((s: Stream) => ({ label: s.channelName, value: s.id })));
    } catch {
      console.error('Failed to fetch streams');
    }
  }, [token]);

  useEffect(() => {
    void Promise.resolve().then(() => fetchUsers());
    void Promise.resolve().then(() => fetchStreams());
  }, [fetchUsers, fetchStreams]);





  const openNew = () => {
    setUserForm({ username: '', password: '', roles: ['STREAM_MANAGER'], authorizedStreamIds: [] });
    setIsEditMode(false);
    setSelectedUser(null);
    setError('');
    setDisplayDialog(true);
  };

  const editUser = (user: User) => {
    setUserForm({ 
      username: user.username, 
      password: '', 
      roles: user.roles || [],
      authorizedStreamIds: user.authorizedStreams ? user.authorizedStreams.map((s: Stream) => s.id) : []
    }); 
    setIsEditMode(true);
    setSelectedUser(user);
    setError('');
    setDisplayDialog(true);
  };

  const handleSaveUser = async () => {
    if (!userForm.username) {
      setError('Username is required');
      return;
    }

    if (!isEditMode && (!userForm.roles || userForm.roles.length === 0)) {
      setError('At least one role is required');
      return;
    }

    if (!isEditMode && !userForm.password) {
      setError('Password is required for new accounts');
      return;
    }

    setLoading(true);
    setError('');
    try {
      if (isEditMode && selectedUser) {
        await axios.put(`${API_BASE_URL}/api/users/${selectedUser.id}`, userForm, {
          headers: { Authorization: `Bearer ${token}` }
        });
        toast.current?.show({ severity: 'success', summary: 'Updated', detail: 'User updated successfully', life: 3000 });
      } else {
        await axios.post(`${API_BASE_URL}/api/users`, userForm, {
          headers: { Authorization: `Bearer ${token}` }
        });
        toast.current?.show({ severity: 'success', summary: 'Created', detail: 'User created successfully', life: 3000 });
      }
      setDisplayDialog(false);
      fetchUsers();
    } catch (err: unknown) {
      setError((axios.isAxiosError<{ error: string }>(err) ? err.response?.data?.error : undefined) || 'Failed to save user');
    } finally {
      setLoading(false);
    }
  };

  const deleteUser = async (id: string) => {
    confirmDialog({
      message: 'Are you sure you want to delete this user?',
      header: 'Delete Confirmation',
      icon: 'pi pi-exclamation-triangle',
      acceptClassName: 'p-button-danger',
      accept: async () => {
        try {
          await axios.delete(`${API_BASE_URL}/api/users/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          toast.current?.show({ severity: 'success', summary: 'Deleted', detail: 'User removed successfully', life: 3000 });
          fetchUsers();
        } catch {
          toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to delete user', life: 3000 });
        }
      }
    });
  };

  const updatePermissions = async (user: User, streamIds: string[]) => {
    try {
      await axios.put(`${API_BASE_URL}/api/users/${user.id}`, {
        ...user,
        authorizedStreamIds: streamIds
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      toast.current?.show({ severity: 'success', summary: 'Saved', detail: 'Permissions updated', life: 2000 });
      fetchUsers();
    } catch {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to save permissions', life: 3000 });
    }
  };

  const onRoleChange = (e: { value: string[] }) => {
    const selectedRoles = e.value;
    const lastSelected = selectedRoles[selectedRoles.length - 1];

    if (lastSelected === 'ADMIN' || lastSelected === 'CLIENT') {
      // Exclusivity: if ADMIN or CLIENT is picked, they take over completely
      setUserForm({ ...userForm, roles: [lastSelected] });
    } else {
      // If picking other roles, filter out ADMIN and CLIENT
      const filtered = selectedRoles.filter((r: string) => r !== 'ADMIN' && r !== 'CLIENT');
      setUserForm({ ...userForm, roles: filtered });
    }
  };

  const actionBody = (rowData: User) => {
    const currentUsername = localStorage.getItem('username');
    return (
      <div className="flex justify-content-end pr-2 gap-2">
        <Button 
          icon="pi pi-pencil" 
          className="p-button-warning p-button-sm p-button-text" 
          onClick={() => editUser(rowData)} 
          tooltip="Edit User"
          tooltipOptions={{ position: 'top' }}
        />
        <Button 
          icon="pi pi-trash" 
          className="p-button-danger p-button-sm p-button-text" 
          disabled={rowData.username === currentUsername}
          onClick={() => deleteUser(rowData.id)} 
          tooltip="Delete User"
          tooltipOptions={{ position: 'top' }}
        />
      </div>
    );
  };

  const roles = [
    { label: 'Admin', value: 'ADMIN' },
    { label: 'Stream Manager', value: 'STREAM_MANAGER' },
    { label: 'Client', value: 'CLIENT' }
  ];

  const rowExpansionTemplate = (data: User) => {
    return (
      <UserStreamPermissions 
        user={data} 
        availableStreams={availableStreams} 
        onSave={updatePermissions} 
      />
    );
  };

  const authorizedStreamsBody = (rowData: User) => {
    if (rowData.roles && rowData.roles.includes('ADMIN')) return <span style={{ color: 'var(--green)' }}>Full Access</span>;
    const count = rowData.authorizedStreams ? rowData.authorizedStreams.length : 0;
    return <span>{count} Authorized Stream(s)</span>;
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)' }}>
      <Toast ref={toast} />
      <Header />
      
      <div className="p-4">
        <div className="flex justify-content-between align-items-center mb-4 px-3">
          <div className="flex align-items-center gap-3">
            <Button icon="pi pi-arrow-left" className="p-button-text p-button-sm text-white" onClick={() => navigate('/dashboard')} />
            <h2 className="m-0" style={{ color: 'var(--text-h)' }}>User Management</h2>
          </div>
          <Button label="Create New User" icon="pi pi-user-plus" className="p-button-sm" style={{ backgroundColor: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={openNew} />
        </div>

        <div className="px-3">
          <DataTable 
            value={users} 
            responsiveLayout="scroll" 
            className="shadow-none border-1" 
            style={{ borderColor: 'var(--base01)' }}
            expandedRows={expandedRows ?? undefined}
            onRowToggle={(e) => setExpandedRows(e.data)}
            rowExpansionTemplate={rowExpansionTemplate}
            dataKey="id"
          >
            <Column expander style={{ width: '3em' }} headerStyle={{ backgroundColor: 'var(--bg-highlight)' }} bodyStyle={{ backgroundColor: 'var(--bg)' }} />
            <Column field="username" header="Username" sortable headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)' }} />
            <Column header="Roles" body={(rowData) => rowData.roles?.join(', ') || ''} sortable headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)' }} />
            <Column header="Access" body={authorizedStreamsBody} headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)' }} />
            <Column field="createdAt" header="Created At" body={(rowData) => new Date(rowData.createdAt).toLocaleString()} sortable headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)' }} />
            <Column header="" body={actionBody} headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)', textAlign: 'right' }} bodyStyle={{ backgroundColor: 'var(--bg)', textAlign: 'right' }} />
          </DataTable>
        </div>
      </div>

      <Dialog header={isEditMode ? 'Edit User Account' : 'New User Account'} visible={displayDialog} style={{ width: '500px' }} onHide={() => setDisplayDialog(false)}
        footer={<div>
          <Button label="Cancel" icon="pi pi-times" onClick={() => setDisplayDialog(false)} className="p-button-text" />
          <Button label={isEditMode ? 'Update' : 'Create'} icon="pi pi-check" onClick={handleSaveUser} loading={loading} autoFocus />
        </div>}>
        <div className="flex flex-column align-items-center gap-3 mt-2">
          <div className="flex flex-column gap-2" style={{ width: '350px' }}>
            <label className="text-sm font-bold" style={{ color: 'var(--text-h)' }}>Username</label>
            <InputText value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)', width: '100%' }} />
          </div>
          
          <div className="flex flex-column gap-2" style={{ width: '350px' }}>
            <label className="text-sm font-bold" style={{ color: 'var(--text-h)' }}>Role(s)</label>
            <MultiSelect value={userForm.roles} options={roles} onChange={onRoleChange} placeholder="Select Roles" className="w-full" style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} display="chip" />
          </div>

          <div className="flex flex-column gap-2" style={{ width: '350px' }}>
            <div className="flex justify-content-between align-items-center">
              <label className="text-sm font-bold" style={{ color: 'var(--text-h)' }}>Password</label>
              {isEditMode && <small style={{ color: 'var(--base01)' }}>(Optional)</small>}
            </div>
            <Password value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} feedback={false} toggleMask inputStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)', width: '100%' }} style={{ width: '100%' }} placeholder={isEditMode ? 'Leave blank to keep current' : ''} />
          </div>
          {error && <Message severity="error" text={error} />}
        </div>
      </Dialog>
    </div>
  );
};

export default UserManagement;
