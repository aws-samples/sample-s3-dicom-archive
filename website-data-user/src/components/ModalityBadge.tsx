import React from 'react';
import { SpaceBetween } from '@cloudscape-design/components';

const COLORS: Record<string, string> = {
  CT: '#0972d3', MR: '#1b9e77', US: '#5e4fa2', XA: '#d95f02', PT: '#ad1457',
  NM: '#4a8c1c', CR: '#7c8500', DX: '#b8860b', MG: '#6a3d9a', RF: '#1565c0',
  SC: '#2e7d32', DOC: '#795548', SR: '#558b2f', SEG: '#7b1fa2', SM: '#e65100',
  OT: '#616161', XC: '#00838f', ES: '#5c6bc0', IO: '#bf5b3f', KO: '#1976d2',
  PR: '#ef6c00', REG: '#689f38', RTDOSE: '#8e24aa', RTPLAN: '#546e7a',
  RTSTRUCT: '#2e7d32', RTIMAGE: '#f9a825',
};
const FALLBACK = ['#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00','#a65628','#f781bf','#999999'];

const getColor = (code: string): string => COLORS[code] || FALLBACK[Array.from(code).reduce((a, c) => a + c.charCodeAt(0), 0) % FALLBACK.length];

const style = (bg: string): React.CSSProperties => ({
  display: 'inline-block', padding: '1px 8px', borderRadius: 4, fontSize: 12,
  fontWeight: 400, color: '#fff', background: bg, lineHeight: '20px', whiteSpace: 'nowrap',
});

export const ModalityBadge: React.FC<{ modality: string }> = ({ modality }) => (
  <span style={style(getColor(modality))} title={modality}>{modality}</span>
);

export const ModalityBadges: React.FC<{ modalities: string[] }> = ({ modalities }) => (
  modalities.length > 0 ? (
    <SpaceBetween direction="horizontal" size="xxs">
      {modalities.map((m, i) => <ModalityBadge key={i} modality={m} />)}
    </SpaceBetween>
  ) : <span>-</span>
);
