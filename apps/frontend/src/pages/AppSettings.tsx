import React, { useState, useEffect, useRef } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Toast } from 'primereact/toast';
import { TabView, TabPanel } from 'primereact/tabview';
import { io } from 'socket.io-client';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import Header from '../components/Header';
import { API_BASE_URL, SOCKET_URL } from '../config';

const AppSettings = () => {
  const [settings, setSettings] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [displayDialog, setDisplayDialog] = useState(false);
  const [selectedSetting, setSelectedStream] = useState<any>(null);
  const [editForm, setEditForm] = useState({ value: '', description: '' });
  const [loading, setLoading] = useState(false);
  const [fetchingLogs, setFetchingLogs] = useState(false);
  
  const toast = useRef<Toast>(null);
  const navigate = useNavigate();
  const token = localStorage.getItem('token');

  useEffect(() => {
    fetchSettings();

    const socket = io(SOCKET_URL, {
      auth: { token }
    });

    socket.on('new_security_log', (log) => {
      setLogs(prev => [log, ...prev].slice(0, 500)); // Keep only last 500
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (activeIndex === 1) {
      fetchLogs();
    }
  }, [activeIndex]);

  const fetchSettings = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/settings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setSettings(response.data);
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to fetch settings', life: 3000 });
    }
  };

  const fetchLogs = async () => {
    setFetchingLogs(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/api/logs`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setLogs(response.data || []);
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to fetch security logs', life: 3000 });
    } finally {
      setFetchingLogs(false);
    }
  };

  const editSetting = (setting: any) => {
    setSelectedStream(setting);
    setEditForm({ value: setting.value, description: setting.description || '' });
    setDisplayDialog(true);
  };

  const saveSetting = async () => {
    setLoading(true);
    try {
      await axios.put(`${API_BASE_URL}/api/settings/${selectedSetting.key}`, editForm, {
        headers: { Authorization: `Bearer ${token}` }
      });
      toast.current?.show({ severity: 'success', summary: 'Success', detail: 'Setting updated successfully', life: 3000 });
      setDisplayDialog(false);
      fetchSettings();
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to update setting', life: 3000 });
    } finally {
      setLoading(false);
    }
  };

  const actionBody = (rowData: any) => {
    return (
      <Button icon="pi pi-pencil" className="p-button-text p-button-sm" onClick={() => editSetting(rowData)} />
    );
  };

  const eventBody = (rowData: any) => {
    let color = 'var(--text)';
    const ev = (rowData.event || '').toUpperCase();
    if (ev.includes('FAILURE') || ev.includes('DELETED') || ev.includes('STOPPED') || ev.includes('KICKED')) color = 'var(--red)';
    else if (ev.includes('SUCCESS') || ev.includes('CREATED') || ev.includes('ENABLED')) color = 'var(--green)';
    else if (ev.includes('UPDATED') || ev.includes('CHANGED')) color = 'var(--blue)';
    
    return <span className="font-bold" style={{ color }}>{rowData.event}</span>;
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)' }}>
      <Toast ref={toast} />
      <Header />
      
      <div className="p-4 max-w-6xl mx-auto">
        <div className="flex align-items-center gap-3 mb-4 px-3">
          <Button icon="pi pi-arrow-left" className="p-button-text p-button-sm text-white" onClick={() => navigate('/dashboard')} />
          <h2 className="m-0" style={{ color: 'var(--text-h)' }}>Application Control Center</h2>
        </div>

        <div className="px-3">
          <TabView activeIndex={activeIndex} onTabChange={(e) => setActiveIndex(e.index)}>
            <TabPanel header="System Settings" leftIcon="pi pi-cog mr-2">
              <div className="p-4 border-round shadow-none border-1 mb-4" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}>
                <p className="m-0 text-sm" style={{ color: 'var(--base01)' }}>
                  <i className="pi pi-info-circle mr-2"></i>
                  Note: Changing core settings like ports or hostnames may require a manual server restart to take full effect.
                </p>
              </div>

              <DataTable value={settings} responsiveLayout="scroll" className="shadow-none border-1" style={{ borderColor: 'var(--base01)' }}>
                <Column field="key" header="Setting Key" sortable headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--blue)', fontWeight: 'bold' }} />
                <Column field="value" header="Value" headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)' }} />
                <Column field="description" header="Description" headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--base01)' }} />
                <Column field="updatedAt" header="Last Updated" body={(rowData) => new Date(rowData.updatedAt).toLocaleString()} sortable headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--base01)' }} />
                <Column header="" body={actionBody} headerStyle={{ backgroundColor: 'var(--bg-highlight)', textAlign: 'right' }} bodyStyle={{ backgroundColor: 'var(--bg)', textAlign: 'right' }} />
              </DataTable>
            </TabPanel>

            <TabPanel header="Security Audit Logs" leftIcon="pi pi-shield mr-2">
              <div className="flex justify-content-between align-items-center mb-3">
                <span className="text-sm italic" style={{ color: 'var(--base01)' }}>Showing last 500 audit events (Real-time updates enabled)</span>
                <Button label="Refresh Logs" icon="pi pi-refresh" className="p-button-text p-button-sm" onClick={fetchLogs} loading={fetchingLogs} />
              </div>
              <DataTable value={logs} responsiveLayout="scroll" className="shadow-none border-1" style={{ borderColor: 'var(--base01)' }} paginator rows={15}>
                <Column field="createdAt" header="Timestamp" body={(rowData) => new Date(rowData.createdAt).toLocaleString()} sortable headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--base01)', fontSize: '0.85rem' }} />
                <Column header="Event" body={eventBody} sortable field="event" headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)' }} />
                <Column field="username" header="User" sortable headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--blue)' }} />
                <Column field="ip" header="IP Address" headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--base01)', fontSize: '0.85rem' }} />
                <Column field="details" header="Details" headerStyle={{ backgroundColor: 'var(--bg-highlight)', color: 'var(--text-h)' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)', fontSize: '0.85rem' }} />
              </DataTable>
            </TabPanel>
          </TabView>
        </div>
      </div>

      <Dialog header={`Edit Setting: ${selectedSetting?.key}`} visible={displayDialog} style={{ width: '450px' }} onHide={() => setDisplayDialog(false)}
        footer={<div>
          <Button label="Cancel" icon="pi pi-times" onClick={() => setDisplayDialog(false)} className="p-button-text" />
          <Button label="Save" icon="pi pi-check" onClick={saveSetting} loading={loading} autoFocus />
        </div>}>
        <div className="flex flex-column gap-3 mt-2">
          <div className="flex flex-column gap-2">
            <label className="text-sm font-bold">Value</label>
            <InputText value={editForm.value} onChange={(e) => setEditForm({ ...editForm, value: e.target.value })} style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} />
          </div>
          <div className="flex flex-column gap-2">
            <label className="text-sm font-bold">Description</label>
            <InputText value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} />
          </div>
        </div>
      </Dialog>
    </div>
  );
};

export default AppSettings;
