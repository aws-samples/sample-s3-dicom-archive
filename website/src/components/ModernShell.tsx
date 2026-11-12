import React, { useEffect, useRef, useState } from 'react';
import type { SideNavigationProps } from '@cloudscape-design/components';
import { safeHref } from '../utils/safeHref';
import '../styles/modern-shell.css';
import { useTheme } from '../contexts/ThemeContext';
import { modernShellVars } from '../themes/palettes';

/**
 * ModernShell — a fully CUSTOM application chrome (top bar + left sidebar +
 * scrollable content frame) that REPLACES Cloudscape's AppLayout /
 * SideNavigation / TopNavigation, but ONLY while navSkin === 'modern'.
 *
 * It renders the existing route components (App.tsx renderContent()) UNCHANGED
 * inside its content area — the pages keep using Cloudscape components, which is
 * fine. Only the chrome is bespoke.
 *
 * Theming is driven entirely by CSS variables in modern-shell.css. The shell
 * root carries `.modern-dark` or `.modern-light` (from ThemeContext.customTheme)
 * to switch between the two variable sets. No applyTheme() dark override is
 * needed for the shell itself.
 *
 * Nav data is REUSED from App.tsx's privilege-filtered `navigationItems`
 * (SideNavigationProps.Item[]) — we do not re-implement privilege logic. We only
 * know three item shapes: 'link', 'section', 'expandable-link-group'.
 */

export interface ModernShellProps {
  navItems: ReadonlyArray<SideNavigationProps.Item>;
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
  version?: string;
  children: React.ReactNode;
}

/* ---------- icon lookup (keyed on href, mirrors variant-b-nav.css) ---------- */
const ICONS: Record<string, string> = {
  '/dashboard': 'M3 13h8V3H3zM13 21h8V3h-8zM3 21h8v-6H3z',
  '/dicom-studies': 'M3 3h18v18H3zM3 9h18M9 21V9',
  '/imports': 'M12 3v12m0 0l-4-4m4 4l4-4M4 21h16',
  '/non-dicom-import': 'M12 3v12m0 0l-4-4m4 4l4-4M4 21h16',
  '/virtual-folders': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  '/virtual-folder-profiles': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  '/virtual-folder-assignment-rules': 'M4 6h16M4 12h16M4 18h10',
  '/analytics-projects': 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  '/analytics-query': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  '/processing-jobs': 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2',
  '/datastores': 'M12 2c4.4 0 8 1.3 8 3v14c0 1.7-3.6 3-8 3s-8-1.3-8-3V5c0-1.7 3.6-3 8-3zM4 5c0 1.7 3.6 3 8 3s8-1.3 8-3',
  '/locations': 'M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11zM12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  '/dicom-entities': 'M4 4h16v16H4zM9 9h2v6H9zm5 0h1a2 2 0 0 1 0 6h-1z',
  '/dicom-interfaces': 'M3 4h18v12H3zM8 20h8M12 16v4',
  '/routing': 'M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6M6 3l-3 3m3-3l3 3M18 21l-3-3m3 3l3-3',
  '/users': 'M9 4.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4zM3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a5.5 5.5 0 0 0-4-5.3',
  '/groups': 'M12 3l7 3v6c0 5-3.5 7.7-7 9-3.5-1.3-7-4-7-9V6z',
  '/audit': 'M9 3h6l4 4v14H5V3zM9 12h6M9 16h6',
  '/interface-servers': 'M3 4h18v12H3zM8 20h8M12 16v4',
  '/system-monitor': 'M3 4h18v12H3zM8 20h8M12 16v4',
  '/aws-resources': 'M3 15c4 3 14 3 18 0M5 9c3 2 11 2 14 0M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  '/debug/auth-token': 'M15 7a5 5 0 1 0-4.9 6H13v3h3v3h4v-4l-5-5z',
};
const FALLBACK_ICON = 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z';

// `route` selects an SVG icon only; it is never rendered as a link target.
const NavIcon: React.FC<{ route?: string }> = ({ route }) => (
  <svg
    className="ms-ic"
    viewBox="0 0 24 24"
    width={18}
    height={18}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d={(route && ICONS[route]) || FALLBACK_ICON} />
  </svg>
);

/* Does an expandable group contain the active href (in itself or a child)? */
const groupHasActive = (
  group: SideNavigationProps.ExpandableLinkGroup,
  activeHref: string,
): boolean =>
  group.href === activeHref ||
  (group.items || []).some((c) => (c as any).href === activeHref);

const ModernShell: React.FC<ModernShellProps> = ({
  navItems,
  activeHref,
  onNavigate,
  currentUser,
  onOpenPalette,
  onOpenPreferences,
  onOpenProfile,
  onOpenChangelog,
  onSignout,
  toggleTheme,
  customTheme,
  dataUserUrl,
  version,
  children,
}) => {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('navCollapsed') === 'true',
  );
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('navCollapsed', String(collapsed));
  }, [collapsed]);

  // Close the user menu on outside click / Escape.
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [userMenuOpen]);

  const rootClass = `modern-shell ${customTheme === 'dark' ? 'modern-dark' : 'modern-light'}${
    collapsed ? ' ms-collapsed' : ''
  }`;
  // A palette theme overrides the .modern-dark / .modern-light defaults inline,
  // since those classes would otherwise win over variables set on :root.
  const { colorTheme } = useTheme();
  const shellVars = (colorTheme.palette
    ? modernShellVars(colorTheme.palette, colorTheme.mode)
    : undefined) as React.CSSProperties | undefined;

  const navClick = (
    e: React.MouseEvent,
    href: string | undefined,
    external?: boolean,
  ) => {
    if (external) return; // let the anchor navigate normally
    e.preventDefault();
    if (href) onNavigate(href);
  };

  const isGroupOpen = (group: SideNavigationProps.ExpandableLinkGroup, key: string) => {
    // Explicit user toggle wins; otherwise default open when it holds the active item.
    if (key in openGroups) return openGroups[key];
    return groupHasActive(group, activeHref);
  };

  const renderLink = (
    item: SideNavigationProps.Link,
    depth: number,
  ) => {
    const active = item.href === activeHref;
    return (
      <a
        key={item.href}
        href={safeHref(item.href)}
        aria-label={item.text}
        aria-current={active ? 'page' : undefined}
        className={`ms-nav-link${active ? ' ms-active' : ''}${depth > 0 ? ' ms-child' : ''}`}
        onClick={(e) => navClick(e, item.href, (item as any).external)}
        title={collapsed ? item.text : undefined}
      >
        <NavIcon route={item.href} />
        <span className="ms-nav-label">{item.text}</span>
      </a>
    );
  };

  const renderGroup = (
    group: SideNavigationProps.ExpandableLinkGroup,
    sectionKey: string,
    idx: number,
  ) => {
    const key = `${sectionKey}:${group.href || group.text || idx}`;
    const open = isGroupOpen(group, key);
    const active = group.href === activeHref;
    return (
      <div key={key} className="ms-group">
        <button
          type="button"
          className={`ms-nav-link ms-group-head${active ? ' ms-active' : ''}`}
          aria-expanded={open}
          aria-label={group.text}
          title={collapsed ? group.text : undefined}
          onClick={() => setOpenGroups((g) => ({ ...g, [key]: !open }))}
        >
          <NavIcon route={group.href} />
          <span className="ms-nav-label">{group.text}</span>
          <svg
            className={`ms-caret${open ? ' ms-caret-open' : ''}`}
            viewBox="0 0 24 24"
            width={14}
            height={14}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
            focusable="false"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
        {open && !collapsed && (
          <div className="ms-group-items" role="group" aria-label={group.text}>
            {(group.items || []).map((child) =>
              (child as any).type === 'link'
                ? renderLink(child as SideNavigationProps.Link, 1)
                : null,
            )}
          </div>
        )}
      </div>
    );
  };

  const renderNav = () =>
    navItems.map((item, i) => {
      if (item.type === 'link') {
        return renderLink(item as SideNavigationProps.Link, 0);
      }
      if (item.type === 'section') {
        const section = item as SideNavigationProps.Section;
        const sectionKey = `sec:${section.text || i}`;
        return (
          <div key={sectionKey} className="ms-section">
            <div className="ms-section-title">{section.text}</div>
            {(section.items || []).map((child, j) => {
              if ((child as any).type === 'link') {
                return renderLink(child as SideNavigationProps.Link, 0);
              }
              if ((child as any).type === 'expandable-link-group') {
                return renderGroup(
                  child as SideNavigationProps.ExpandableLinkGroup,
                  sectionKey,
                  j,
                );
              }
              return null;
            })}
          </div>
        );
      }
      if (item.type === 'expandable-link-group') {
        return renderGroup(
          item as SideNavigationProps.ExpandableLinkGroup,
          `top:${i}`,
          i,
        );
      }
      return null;
    });

  return (
    <div className={rootClass} style={shellVars}>
      {/* ---------------- Fixed top bar ---------------- */}
      <header className="ms-topbar">
        <div className="ms-topbar-left">
          <button
            type="button"
            className="ms-icon-btn ms-collapse-btn"
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="ms-title">DICOM Archive</span>
          <button
            type="button"
            className="ms-search-pill"
            onClick={onOpenPalette}
            aria-label="Open command palette"
          >
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <span className="ms-search-text">Search</span>
            <kbd className="ms-kbd">⌘K</kbd>
          </button>
        </div>

        <div className="ms-topbar-right">
          <span className="ms-warning" role="note">Not for Diagnosis or Treatment</span>
          {dataUserUrl && (
            <a
              className="ms-toplink"
              href={safeHref(dataUserUrl)}
              target="_blank"
              rel="noreferrer"
            >
              Data User View
            </a>
          )}
          <a
            className="ms-toplink"
            href="https://docs.aws.amazon.com/"
            target="_blank"
            rel="noreferrer"
          >
            Documentation
          </a>
          {version && (
            <button type="button" className="ms-version-btn" onClick={onOpenChangelog} aria-label="Version history">
              v{version}
            </button>
          )}
          <button
            type="button"
            className="ms-icon-btn"
            aria-label={customTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggleTheme}
          >
            {customTheme === 'dark' ? (
              <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                <circle cx="12" cy="12" r="4.5" />
                <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              </svg>
            )}
          </button>

          <div className="ms-usermenu" ref={userMenuRef}>
            <button
              type="button"
              className="ms-user-btn"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              aria-label="User menu"
              onClick={() => setUserMenuOpen((o) => !o)}
            >
              <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
                <circle cx="12" cy="8" r="3.4" />
                <path d="M5 20a7 7 0 0 1 14 0" />
              </svg>
              <span className="ms-user-name">{currentUser?.username || 'User'}</span>
            </button>
            {userMenuOpen && (
              <div className="ms-menu" role="menu">
                <button type="button" role="menuitem" className="ms-menu-item" onClick={() => { setUserMenuOpen(false); onOpenProfile(); }}>Profile</button>
                <button type="button" role="menuitem" className="ms-menu-item" onClick={() => { setUserMenuOpen(false); onOpenPreferences(); }}>Preferences</button>
                <div className="ms-menu-sep" />
                <button type="button" role="menuitem" className="ms-menu-item" onClick={() => { setUserMenuOpen(false); onSignout(); }}>Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ---------------- Body: sidebar + content ---------------- */}
      <div className="ms-body">
        <nav className="ms-sidebar" aria-label="Primary navigation">
          <div className="ms-nav-scroll">{renderNav()}</div>
        </nav>
        <main className="ms-content" role="main">
          <div className="ms-content-inner">{children}</div>
        </main>
      </div>
    </div>
  );
};

export default ModernShell;
