import React from 'react';
import { Button } from 'primereact/button';
import { InputText } from 'primereact/inputtext';

interface ConnectionInfoCardProps {
  label: string;
  value: string;
  onCopy: (text: string) => void;
}

const ConnectionInfoCard: React.FC<ConnectionInfoCardProps> = ({ label, value, onCopy }) => {
  return (
    <div className="p-3 border-round" style={{ backgroundColor: 'var(--bg-highlight)' }}>
      <label className="block font-bold mb-2" style={{ color: 'var(--text-h)' }}>{label}</label>
      <div className="flex gap-2">
        <InputText 
          readOnly 
          value={value} 
          className="flex-grow-1 p-inputtext-sm" 
          style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} 
        />
        <Button icon="pi pi-copy" onClick={() => onCopy(value)} className="p-button-sm" />
      </div>
    </div>
  );
};

export default ConnectionInfoCard;
