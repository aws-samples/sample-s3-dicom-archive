import React, { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ChevronDown, ChevronUp, Database, FolderTree, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen,
  Search, Settings, ShieldAlert, Sun, Upload, X,
} from 'lucide-react';
import { cn } from './util';
import { BrandMark } from './brand';

/**
 * Data-user application chrome, in the website design: a collapsible sidebar
 * listing the storages and virtual folders the user can browse, a top bar, and
 * a resizable bottom panel (the old Cloudscape SplitPanel) for study details.
 */

export interface ShellSource { id: string; name: string; type: 'datastore' | 'virtualFolder' }

export interface DataUserShellProps {
  sources: ShellSource[];
  sourcesLoading: boolean;
  activeSourceId?: string;
  onOpenSource: (source: ShellSource) => void;
  title?: string;
  currentUser?: { username?: string } | null;
  onOpenPreferences: () => void;
  onSignout: () => void;
  toggleTheme: () => void;
  customTheme: 'light' | 'dark';
  version?: string;
  /** Non-DICOM Import V2 "Import files" entry; omitted when not offered to this user. */
  importEntry?: { active: boolean; onOpen: () => void };
  splitPanel?: {
    content: React.ReactNode;
    open: boolean;
    size: number;
    onToggle: (open: boolean) => void;
    onResize: (size: number) => void;
  };
  children: React.ReactNode;
}

const SECTIONS: Array<{ type: ShellSource['type']; label: string; icon: React.ElementType }> = [
  { type: 'datastore', label: 'Storages', icon: Database },
  { type: 'virtualFolder', label: 'Virtual folders', icon: FolderTree },
];

function SourceNav({ sources, loading, active, collapsed, onOpen }: {
  sources: ShellSource[]; loading: boolean; active?: string; collapsed: boolean; onOpen: (s: ShellSource) => void;
}) {
  const [filter, setFilter] = useState('');
  if (loading) {
    return <div className="px-2.5 py-2 text-sm text-muted-foreground">{collapsed ? '…' : 'Loading sources…'}</div>;
  }
  if (sources.length === 0) {
    return collapsed ? null : <div className="px-2.5 py-2 text-sm text-muted-foreground">No storages or folders available.</div>;
  }
  const q = filter.trim().toLowerCase();
  const shown = q ? sources.filter(s => s.name.toLowerCase().includes(q)) : sources;
  return (
    <nav aria-label="Data sources" className="flex flex-col gap-0.5">
      {!collapsed && sources.length > 8 && (
        <label className="mb-2 flex h-8 items-center gap-2 rounded-lg border bg-background px-2.5 text-sm text-muted-foreground focus-within:border-ring/60">
          <Search size={14} className="shrink-0" />
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter sources"
            aria-label="Filter sources" className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground" />
        </label>
      )}
      {SECTIONS.map(sec => {
        const list = shown.filter(s => s.type === sec.type);
        if (list.length === 0) return null;
        return (
          <div key={sec.type} className="mt-4 first:mt-0">
            {!collapsed
              ? <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{sec.label}</div>
              : <div className="mx-3 mb-2 border-t border-sidebar-border" />}
            <div className="flex flex-col gap-0.5">
              {list.map(s => {
                const on = s.id === active;
                const btn = (
                  <button key={s.id} type="button" aria-current={on ? 'page' : undefined} onClick={() => onOpen(s)}
                    aria-label={collapsed ? `${s.name} (${sec.label})` : undefined}
                    className={cn('group relative flex h-8 w-full items-center gap-2.5 rounded-lg text-left text-sm font-medium transition-colors',
                      collapsed ? 'justify-center px-0' : 'px-2.5',
                      on ? 'bg-sidebar-accent text-foreground' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground')}>
                    {on && !collapsed && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-primary" />}
                    <sec.icon size={16} strokeWidth={1.9} className={cn('shrink-0', on ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
                    {!collapsed && <span className="truncate">{s.name}</span>}
                  </button>
                );
                if (!collapsed) return btn;
                return (
                  <Tooltip.Root key={s.id} delayDuration={150}>
                    <Tooltip.Trigger asChild>{btn}</Tooltip.Trigger>
                    <Tooltip.Portal><Tooltip.Content side="right" sideOffset={8} className="z-50 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow">{s.name}</Tooltip.Content></Tooltip.Portal>
                  </Tooltip.Root>
                );
              })}
            </div>
          </div>
        );
      })}
      {!collapsed && q && shown.length === 0 && <div className="px-2.5 py-2 text-sm text-muted-foreground">No match.</div>}
    </nav>
  );
}

function BottomPanel({ content, open, size, onToggle, onResize }: NonNullable<DataUserShellProps['splitPanel']>) {
  const drag = useRef<{ y: number; size: number } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      const max = Math.max(160, window.innerHeight - 220);
      onResize(Math.min(max, Math.max(140, drag.current.size + (drag.current.y - e.clientY))));
    };
    const up = () => { drag.current = null; document.body.style.userSelect = ''; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [onResize]);

  if (!content) return null;
  if (!open) {
    return (
      <div className="flex shrink-0 justify-end border-t bg-card px-4 py-1.5 md:px-6">
        <button type="button" onClick={() => onToggle(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground">
          <ChevronUp size={15} /> Show study details
        </button>
      </div>
    );
  }
  return (
    <section aria-label="Study details" className="relative flex shrink-0 flex-col border-t bg-card" style={{ height: size }}>
      <div role="separator" aria-orientation="horizontal" aria-label="Resize study details"
        onPointerDown={e => { drag.current = { y: e.clientY, size }; document.body.style.userSelect = 'none'; }}
        className="absolute inset-x-0 -top-1 h-2 cursor-row-resize hover:bg-primary/30" />
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-4 md:px-6">
        <span className="text-sm font-semibold">Study details</span>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Hide study details" onClick={() => onToggle(false)}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"><ChevronDown size={16} /></button>
          <button type="button" aria-label="Close study details" onClick={() => onToggle(false)}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"><X size={15} /></button>
        </div>
      </div>
      <div className="ui-scroll min-h-0 flex-1 overflow-auto px-4 py-3 md:px-6">{content}</div>
    </section>
  );
}

export function DataUserShell({ sources, sourcesLoading, activeSourceId, onOpenSource, title, currentUser, onOpenPreferences,
  onSignout, toggleTheme, customTheme, version, importEntry, splitPanel, children }: DataUserShellProps) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('navCollapsed') === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { localStorage.setItem('navCollapsed', String(collapsed)); }, [collapsed]);
  const initials = (currentUser?.username || 'U').slice(0, 2).toUpperCase();
  const open = (s: ShellSource) => { setMobileOpen(false); onOpenSource(s); };

  const sidebar = (isMobile: boolean) => (
    <aside className={cn('flex h-full flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200',
      isMobile ? 'w-[264px]' : collapsed ? 'w-[60px]' : 'w-[248px]')}>
      <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border', collapsed && !isMobile ? 'justify-center px-0' : 'px-4')}>
        <BrandMark size={30} className="shrink-0" />
        {(!collapsed || isMobile) && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold tracking-tight">DICOM Archive</div>
            <div className="truncate text-[11px] font-medium text-muted-foreground">Data View</div>
          </div>
        )}
      </div>
      <div className={cn('ui-scroll flex-1 overflow-y-auto py-3', collapsed && !isMobile ? 'px-2' : 'px-2.5')}>
        <Tooltip.Provider>
          {importEntry && (() => {
            const narrow = collapsed && !isMobile;
            const btn = (
              <button type="button" aria-current={importEntry.active ? 'page' : undefined}
                aria-label={narrow ? 'Import files' : undefined}
                onClick={() => { setMobileOpen(false); importEntry.onOpen(); }}
                className={cn('group relative mb-3 flex h-8 w-full items-center gap-2.5 rounded-lg text-left text-sm font-medium transition-colors',
                  narrow ? 'justify-center px-0' : 'px-2.5',
                  importEntry.active ? 'bg-sidebar-accent text-foreground' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground')}>
                {importEntry.active && !narrow && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-primary" />}
                <Upload size={16} strokeWidth={1.9} className={cn('shrink-0', importEntry.active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
                {!narrow && <span className="truncate">Import files</span>}
              </button>
            );
            return narrow ? (
              <Tooltip.Root delayDuration={150}>
                <Tooltip.Trigger asChild>{btn}</Tooltip.Trigger>
                <Tooltip.Portal><Tooltip.Content side="right" sideOffset={8} className="z-50 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow">Import files</Tooltip.Content></Tooltip.Portal>
              </Tooltip.Root>
            ) : btn;
          })()}
          <SourceNav sources={sources} loading={sourcesLoading} active={activeSourceId} collapsed={collapsed && !isMobile} onOpen={open} />
        </Tooltip.Provider>
      </div>
      {!isMobile && (
        <div className="shrink-0 border-t border-sidebar-border p-2">
          <button type="button" onClick={() => setCollapsed(c => !c)} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className={cn('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground', collapsed && 'justify-center px-0')}>
            {collapsed ? <PanelLeftOpen size={17} /> : <><PanelLeftClose size={17} /><span>Collapse</span></>}
          </button>
        </div>
      )}
    </aside>
  );

  const iconBtn = 'inline-flex size-8.5 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground';
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <div className="hidden md:flex">{sidebar(false)}</div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0">{sidebar(true)}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/70 md:px-6">
          <button type="button" className={cn(iconBtn, 'md:hidden')} aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={18} /></button>
          <h1 className="min-w-0 truncate text-sm font-semibold">{title || 'Studies'}</h1>
          <span className="ml-1 hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-warning/40 bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-warning lg:inline-flex">
            <ShieldAlert size={13} /> Not for Diagnosis or Treatment
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button type="button" onClick={toggleTheme} aria-label={customTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} className={iconBtn}>
              {customTheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            {version && <span className="hidden h-7 items-center px-2 font-mono text-xs text-muted-foreground xl:inline-flex">v{version}</span>}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" aria-label="User menu" className="ml-1 flex items-center gap-2 rounded-full p-0.5 pr-2 hover:bg-secondary">
                  <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">{initials}</span>
                  <span className="hidden max-w-32 truncate text-sm font-medium lg:inline">{currentUser?.username || 'User'}</span>
                  <ChevronDown size={14} className="hidden text-muted-foreground lg:inline" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-56 rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl animate-[ui-slide-down_.12s_ease-out]">
                  <div className="truncate px-2.5 py-2 text-sm font-semibold">{currentUser?.username || 'User'}</div>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item onSelect={onOpenPreferences} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-secondary">
                    <Settings size={15} className="text-muted-foreground" />Preferences
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item onSelect={onSignout} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-destructive outline-none data-[highlighted]:bg-destructive/10">
                    <LogOut size={15} />Sign out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>
        <main id="main-content" tabIndex={0} aria-label="Content" className="ui-scroll min-h-0 flex-1 overflow-y-auto focus:outline-none">
          <div className="w-full px-4 py-5 md:px-6">{children}</div>
        </main>
        {splitPanel && <BottomPanel {...splitPanel} />}
      </div>
    </div>
  );
}

/** Cloudscape SplitPanel stand-in: the shell's bottom panel supplies the chrome. */
export function SplitPanel({ children }: { children?: React.ReactNode; header?: React.ReactNode }) {
  return <>{children}</>;
}
