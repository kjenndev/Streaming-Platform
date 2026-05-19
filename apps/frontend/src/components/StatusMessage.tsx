import React from 'react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';

interface StatusMessageProps {
  title: string;
  icon: string;
  iconColor: string;
  message: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}

const StatusMessage: React.FC<StatusMessageProps> = ({ 
  title, 
  icon, 
  iconColor, 
  message, 
  actionLabel, 
  onAction 
}) => {
  return (
    <div className="flex align-items-center justify-content-center" style={{ height: '100vh', backgroundColor: 'var(--bg)' }}>
      <Card title={title} style={{ width: '90%', maxWidth: '400px' }} className="shadow-8 border-1 border-white-alpha-10 bg-gray-900 text-center">
        <div className="flex flex-column align-items-center gap-3 py-4">
          <i className={icon} style={{ fontSize: '3rem', color: iconColor }}></i>
          <p style={{ color: 'var(--text)' }}>
            {message}
          </p>
          {actionLabel && onAction && (
            <Button label={actionLabel} icon="pi pi-home" className="p-button-text" style={{ width: '150px' }} onClick={onAction} />
          )}
        </div>
      </Card>
    </div>
  );
};

export default StatusMessage;
