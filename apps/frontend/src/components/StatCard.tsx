import React from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  valueColor?: string;
  chart?: React.ReactNode;
  chartValue?: string | number;
  chartColor?: string;
}

const StatCard: React.FC<StatCardProps> = ({ 
  label, 
  value, 
  valueColor = 'var(--text-h)', 
  chart, 
  chartValue, 
  chartColor = 'var(--green)' 
}) => {
  const statBoxStyle = {
    backgroundColor: 'var(--bg-highlight)',
    borderColor: 'var(--base01)',
    height: '200px',
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '1.2rem',
    borderRadius: '6px'
  };

  return (
    <div className="border-1" style={statBoxStyle}>
      <div className="flex justify-content-between align-items-center mb-2">
        <span className="font-bold uppercase text-xs tracking-wider" style={{ color: 'var(--base01)' }}>{label}</span>
        {chart && <span className="font-bold" style={{ color: chartColor }}>{chartValue}</span>}
      </div>
      <div className="flex-grow-1 flex align-items-center justify-content-center overflow-hidden">
        {chart ? (
          <div className="w-full h-full">
            {chart}
          </div>
        ) : (
          <h2 className="text-primary m-0" style={{ color: valueColor, fontSize: '3.5rem' }}>
            {value}
          </h2>
        )}
      </div>
    </div>
  );
};

export default StatCard;
