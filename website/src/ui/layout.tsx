import React, { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  LayoutDashboard, Images, Upload, BarChart3, Cpu, CalendarClock, Database, ListTree, FolderTree, MapPin,
  Network, Users, ShieldCheck, ScrollText, Server, Activity, Cloud, KeyRound, ChevronDown, ChevronRight,
  Search, Moon, Sun, PanelLeftClose, PanelLeftOpen, ExternalLink, BookOpen, LogOut, Settings, User,
  FolderInput, Route, Tags, Circle, ShieldAlert, Menu,
} from 'lucide-react';
import { cn, fire } from './util';
import { BrandMark } from './brand';
import { safeHref } from '../utils/safeHref';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/* Same item shape as Cloudscape SideNavigation (App.tsx builds it from privileges). */
export type NavItem =
  | { type: 'link'; text: string; href: string; external?: boolean; info?: React.ReactNode }
  | { type: 'section'; text: string; items: NavItem[]; defaultExpanded?: boolean }
  | { type: 'expandable-link-group'; text: string; href: string; items: NavItem[] }
  | { type: 'divider' };

const ROUTE_ICON: Record<string, React.ElementType> = {
  '/dashboard': LayoutDashboard, '/dicom-studies': Images, '/import': Upload, '/imports': Upload, '/analytics-query': BarChart3,
  '/analytics-projects': BarChart3, '/processing-jobs': Cpu, '/processing-job-schedules': CalendarClock, '/datastores': Database,
  '/index-attributes': ListTree, '/virtual-folders': FolderTree, '/virtual-folder-profiles': Tags,
  '/virtual-folder-assignment-rules': FolderInput, '/locations': MapPin, '/dicom-entities': Network, '/dicom-interfaces': Server,
  '/routing': Route, '/users': Users, '/groups': ShieldCheck, '/audit': ScrollText, '/interface-servers': Server,
  '/system-monitor': Activity, '/aws-resources': Cloud, '/debug/auth-token': KeyRound,
};

function hasActive(item: any, active: string): boolean {
  return item.href === active || (item.items || []).some((c: any) => hasActive(c, active));
}

/** Find the section/page titles for the breadcrumb. */
function trail(items: NavItem[], active: string, parents: string[] = []): string[] | null {
  for (const it of items as any[]) {
    if (it.type === 'link' && it.href === active) return [...parents, it.text];
    if (it.items) {
      const t = trail(it.items, active, it.type === 'section' ? [...parents, it.text] : [...parents, it.text]);
      if (t) return t;
    }
  }
  return null;
}

function NavTree({ items, active, collapsed, onFollow }: { items: NavItem[]; active: string; collapsed: boolean; onFollow: (href: string, external?: boolean, e?: any) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const link = (it: any, depth: number) => {
    const Icon = ROUTE_ICON[it.href] || Circle;
    const on = it.href === active;
    const a = (
      <a key={it.href + it.text} href={safeHref(it.href)} target={it.external ? '_blank' : undefined} rel={it.external ? 'noreferrer' : undefined}
        aria-current={on ? 'page' : undefined}
        onClick={(e) => onFollow(it.href, it.external, e)}
        className={cn('group relative flex h-8 items-center gap-2.5 rounded-lg text-sm font-medium transition-colors',
          collapsed ? 'justify-center px-0' : depth ? 'pl-9 pr-2' : 'px-2.5',
          on ? 'bg-sidebar-accent text-foreground' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground')}>
        {on && !collapsed && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-primary" />}
        {(depth === 0 || collapsed) && <Icon size={17} strokeWidth={1.9} className={cn('shrink-0', on ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />}
        {!collapsed && <span className="truncate">{it.text}</span>}
        {!collapsed && it.external && <ExternalLink size={12} className="ml-auto opacity-60" />}
      </a>
    );
    if (!collapsed) return a;
    return (
      <Tooltip.Root key={it.href + it.text} delayDuration={150}>
        <Tooltip.Trigger asChild>{a}</Tooltip.Trigger>
        <Tooltip.Portal><Tooltip.Content side="right" sideOffset={8} className="z-50 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow">{it.text}</Tooltip.Content></Tooltip.Portal>
      </Tooltip.Root>
    );
  };
  const render = (list: NavItem[], depth: number): React.ReactNode => (list as any[]).map((it, i) => {
    if (it.type === 'divider') return <div key={`d${i}`} className="my-2 border-t border-sidebar-border" />;
    if (it.type === 'link') return link(it, depth);
    if (it.type === 'section') {
      return (
        <div key={it.text} className="mt-4 first:mt-0">
          {!collapsed ? <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{it.text}</div>
            : <div className="mx-3 mb-2 border-t border-sidebar-border" />}
          <div className="flex flex-col gap-0.5">{render(it.items || [], 0)}</div>
        </div>
      );
    }
    if (it.type === 'expandable-link-group') {
      const isOpen = open[it.text] ?? hasActive(it, active);
      if (collapsed) return <React.Fragment key={it.text}>{render(it.items || [], 0)}</React.Fragment>;
      const Icon = ROUTE_ICON[it.href] || Circle;
      return (
        <div key={it.text}>
          <button type="button" aria-expanded={isOpen} onClick={() => setOpen(o => ({ ...o, [it.text]: !isOpen }))}
            className={cn('group flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium transition-colors hover:bg-sidebar-accent/60',
              hasActive(it, active) ? 'text-foreground' : 'text-sidebar-foreground/80')}>
            <Icon size={17} strokeWidth={1.9} className={cn('shrink-0', hasActive(it, active) ? 'text-primary' : 'text-muted-foreground')} />
            <span className="flex-1 truncate">{it.text}</span>
            <ChevronRight size={14} className={cn('text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
          </button>
          <div hidden={!isOpen} className="mt-0.5 flex flex-col gap-0.5">{render(it.items || [], depth + 1)}</div>
        </div>
      );
    }
    return null;
  });
  return <nav aria-label="Main" className="flex flex-col gap-0.5">{render(items, 0)}</nav>;
}

export interface AppShellProps {
  navItems: ReadonlyArray<any>;
  activeHref: string;
  onNavigate: (href: string) => void;
  currentUser?: { username?: string; email?: string; groups?: string[] } | null;
  onOpenPalette: () => void;
  onOpenPreferences: () => void;
  onOpenProfile: () => void;
  onOpenChangelog: () => void;
  onSignout: () => void;
  toggleTheme: () => void;
  customTheme: 'light' | 'dark';
  dataUserUrl?: string;
  docsUrl?: string;
  version?: string;
  stackName?: string;
  /** Use the whole content width (no 1680px cap), for wide work surfaces such as Analytics. */
  fullWidth?: boolean;
  children: React.ReactNode;
}

export function AppShell({ navItems, activeHref, onNavigate, currentUser, onOpenPalette, onOpenPreferences, onOpenProfile, onOpenChangelog,
  onSignout, toggleTheme, customTheme, dataUserUrl, docsUrl = 'https://docs.aws.amazon.com/', version, stackName, fullWidth, children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('navCollapsed') === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { localStorage.setItem('navCollapsed', String(collapsed)); }, [collapsed]);
  useEffect(() => { setMobileOpen(false); }, [activeHref]);
  const crumbs = useMemo(() => trail(navItems as NavItem[], activeHref) || ['Dashboard'], [navItems, activeHref]);
  const follow = (href: string, external?: boolean, e?: any) => { if (external) return; e?.preventDefault(); onNavigate(href); };
  const initials = (currentUser?.username || 'U').slice(0, 2).toUpperCase();

  const sidebar = (isMobile: boolean) => (
    <aside className={cn('flex h-full flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200',
      isMobile ? 'w-[264px]' : collapsed ? 'w-[60px]' : 'w-[248px]')}>
      <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border', collapsed && !isMobile ? 'justify-center px-0' : 'px-4')}>
        <BrandMark size={30} className="shrink-0" />
        {(!collapsed || isMobile) && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold tracking-tight">DICOM Archive</div>
            <div className="truncate text-[11px] font-medium text-muted-foreground">{stackName || 'default'} · AWS</div>
          </div>
        )}
      </div>
      <div className={cn('ui-scroll flex-1 overflow-y-auto py-3', collapsed && !isMobile ? 'px-2' : 'px-2.5')}>
        <Tooltip.Provider>
          <NavTree items={navItems as NavItem[]} active={activeHref} collapsed={collapsed && !isMobile} onFollow={follow} />
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
          <nav aria-label="Breadcrumb" className="hidden min-w-0 shrink items-center gap-1.5 whitespace-nowrap text-sm sm:flex">
            {crumbs.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <ChevronRight size={13} className="shrink-0 text-muted-foreground/60" />}
                <span className={cn(i === crumbs.length - 1 ? 'shrink-0 font-semibold text-foreground' : 'min-w-0 truncate text-muted-foreground')}>{c}</span>
              </React.Fragment>
            ))}
          </nav>
          <span className="ml-1 hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-warning/40 bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-warning lg:inline-flex">
            <ShieldAlert size={13} /> Not for Diagnosis or Treatment
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button type="button" onClick={onOpenPalette} aria-label="Open command palette"
              className="mr-1 hidden h-8.5 w-44 items-center gap-2 2xl:w-56 rounded-lg border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:border-ring/50 sm:flex">
              <Search size={15} /><span className="flex-1 text-left">Search…</span>
              <kbd className="whitespace-nowrap rounded border bg-muted px-1.5 font-sans text-[11px] font-medium">{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            <button type="button" onClick={onOpenPalette} aria-label="Search" className={cn(iconBtn, 'sm:hidden')}><Search size={17} /></button>
            {dataUserUrl && (
              <a href={safeHref(dataUserUrl)} target="_blank" rel="noreferrer" className="hidden h-8.5 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground lg:inline-flex">
                Data User View <ExternalLink size={13} />
              </a>
            )}
            <a href={safeHref(docsUrl)} target="_blank" rel="noreferrer" aria-label="Documentation (opens in a new tab)" className={iconBtn}><BookOpen size={17} /></a>
            <button type="button" onClick={toggleTheme} aria-label={customTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} className={iconBtn}>
              {customTheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            {version && (
              <button type="button" onClick={onOpenChangelog} className="hidden h-7 items-center rounded-md px-2 font-mono text-xs text-muted-foreground hover:bg-secondary hover:text-foreground xl:inline-flex">v{version}</button>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" aria-label="User menu" className="ml-1 flex items-center gap-2 rounded-full p-0.5 pr-2 hover:bg-secondary">
                  <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">{initials}</span>
                  <span className="hidden max-w-32 truncate text-sm font-medium lg:inline">{currentUser?.username || 'User'}</span>
                  <ChevronDown size={14} className="hidden text-muted-foreground lg:inline" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-60 rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl animate-[ui-slide-down_.12s_ease-out]">
                  <div className="px-2.5 py-2">
                    <div className="truncate text-sm font-semibold">{currentUser?.username || 'User'}</div>
                    {currentUser?.email && <div className="truncate text-xs text-muted-foreground">{currentUser.email}</div>}
                  </div>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  {[
                    { id: 'profile', label: 'Profile', icon: User, on: onOpenProfile },
                    { id: 'preferences', label: 'Preferences', icon: Settings, on: onOpenPreferences },
                  ].map(it => (
                    <DropdownMenu.Item key={it.id} onSelect={it.on} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-secondary">
                      <it.icon size={15} className="text-muted-foreground" />{it.label}
                    </DropdownMenu.Item>
                  ))}
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
          <div className={fullWidth ? 'w-full px-4 py-6 md:px-6' : 'mx-auto w-full max-w-[1680px] px-4 py-6 md:px-8'}>{children}</div>
        </main>
      </div>
    </div>
  );
}

/* ---- Cloudscape-compatible layout components (kept for API parity) ---- */

export function SideNavigation({ items = [], activeHref = '', onFollow, header }: any) {
  return (
    <div className="p-3">
      {header && <div className="mb-3 px-2 font-semibold">{header.text}</div>}
      <Tooltip.Provider>
        <NavTree items={items} active={activeHref} collapsed={false}
          onFollow={(href, external, e) => { const ev = fire(onFollow, { href, external, text: '' }, e); if (ev.defaultPrevented) e?.preventDefault(); }} />
      </Tooltip.Provider>
    </div>
  );
}

export function TopNavigation({ identity, utilities = [], search }: any) {
  return (
    <div className="flex h-14 items-center gap-4 border-b bg-card px-4">
      <a href={safeHref(identity?.href || '/')} className="text-sm font-semibold">{identity?.title}</a>
      <div className="flex-1">{search}</div>
      <div className="flex items-center gap-2">
        {utilities.map((u: any, i: number) => u.href
          ? <a key={i} href={safeHref(u.href)} target={u.external ? '_blank' : undefined} rel="noreferrer" className="text-sm text-muted-foreground hover:text-foreground">{u.text}</a>
          : <button key={i} type="button" onClick={u.onClick} className="text-sm text-muted-foreground hover:text-foreground">{u.text || u.description}</button>)}
      </div>
    </div>
  );
}

export function AppLayout({ navigation, content, notifications, navigationHide, tools, toolsHide, breadcrumbs }: any) {
  return (
    <div className="flex min-h-screen">
      {!navigationHide && navigation && <aside className="w-64 shrink-0 border-r bg-sidebar">{navigation}</aside>}
      <main className="min-w-0 flex-1 px-6 py-6">
        {notifications}
        {breadcrumbs}
        {content}
      </main>
      {!toolsHide && tools && <aside className="w-80 shrink-0 border-l">{tools}</aside>}
    </div>
  );
}
