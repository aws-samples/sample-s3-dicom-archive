import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Command palette (⌘K / Ctrl-K) — a self-contained overlay mounted inside the
 * existing AppLayout. It does NOT replace Cloudscape's navigation or router; it
 * just navigates by setting window.location.hash / calling onNavigate, and runs
 * a small set of quick actions. Only rendered/opened when the Modern nav skin
 * is active, but harmless otherwise.
 */

export interface CommandItem {
  group: string;
  label: string;
  href?: string;        // navigation target (hash route)
  action?: () => void;  // or an action callback
  keywords?: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
  onNavigate: (href: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose, items, onNavigate }) => {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      i.label.toLowerCase().includes(q) ||
      i.group.toLowerCase().includes(q) ||
      (i.keywords || '').toLowerCase().includes(q)
    );
  }, [query, items]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSel(0);
      // focus after the overlay paints
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => { setSel(0); }, [query]);

  if (!open) return null;

  const run = (item: CommandItem) => {
    onClose();
    if (item.action) item.action();
    else if (item.href) onNavigate(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[sel]) run(filtered[sel]); }
  };

  // Group the filtered items in order, preserving first-seen group order.
  const groups: { name: string; items: { item: CommandItem; idx: number }[] }[] = [];
  filtered.forEach((item, idx) => {
    let g = groups.find(x => x.name === item.group);
    if (!g) { g = { name: item.group, items: [] }; groups.push(g); }
    g.items.push({ item, idx });
  });

  return (
    <div
      role="dialog"
      aria-label="Command palette"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(3,8,14,.5)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        // Match the rest of the admin UI (Cloudscape) instead of the browser
        // default serif; inherited by the input, group headers and item rows.
        fontFamily: 'var(--font-family-base, "Open Sans", "Helvetica Neue", Roboto, Arial, sans-serif)',
      }}
    >
      <div
        onKeyDown={onKeyDown}
        style={{
          marginTop: '12vh', width: 'min(560px, 92vw)',
          background: 'var(--cmdk-bg, #161d28)',
          border: '1px solid var(--cmdk-border, #2c3a4d)',
          borderRadius: 14, boxShadow: '0 20px 60px rgba(0,0,0,.5)', overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to a page or action…"
          aria-label="Search commands"
          style={{
            width: '100%', border: 0, outline: 'none', background: 'transparent',
            color: 'var(--cmdk-ink, #e6edf5)', fontSize: 15, padding: '16px 18px',
            borderBottom: '1px solid var(--cmdk-border, #2c3a4d)',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ maxHeight: '52vh', overflowY: 'auto', padding: '4px 0 8px' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '14px 18px', color: 'var(--cmdk-faint, #6b7a8d)', fontSize: 13 }}>
              No matches
            </div>
          )}
          {groups.map(g => (
            <div key={g.name}>
              <div style={{
                fontSize: 10.5, letterSpacing: '.6px', textTransform: 'uppercase',
                color: 'var(--cmdk-faint, #6b7a8d)', padding: '10px 16px 4px',
              }}>{g.name}</div>
              {g.items.map(({ item, idx }) => (
                <div
                  key={item.label}
                  onMouseEnter={() => setSel(idx)}
                  onMouseDown={(e) => { e.preventDefault(); run(item); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 16px', fontSize: 13.5, cursor: 'pointer',
                    background: idx === sel ? 'var(--cmdk-sel, rgba(59,130,246,.15))' : 'transparent',
                    color: idx === sel ? 'var(--cmdk-ink, #e0ecff)' : 'var(--cmdk-dim, #9fb0c3)',
                  }}
                >
                  <span>{item.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cmdk-faint, #6b7a8d)' }}>↵</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
