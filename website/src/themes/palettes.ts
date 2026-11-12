// Color themes for website (Settings -> Appearance -> Theme).
//
// Each theme is ONE palette that drives every surface:
//  - Cloudscape page content, through applyTheme() design tokens
//    (cloudscapeColorTokens), and
//  - the Modern shell chrome and the few hand-styled widgets (SQL editor),
//    through CSS variables (themeCssVars).
//
// 'light' has no palette: it is stock Cloudscape light, unchanged.
//
// Palette rules (common dark-mode guidance, e.g. Material Design's dark theme):
//  - dark themes use mid-dark greys, never near-black, and show elevation by
//    getting LIGHTER (bg < panel < panelRaised);
//  - body text (ink) and secondary text (dim) keep >= 7:1 and >= 4.5:1 contrast
//    on panel; link/accent text keeps >= 4.5:1;
//  - accentInk is the text color on a primary (accent) button.
// Nord, Catppuccin and Solarized use their published palettes
// (nordtheme.com, catppuccin.com, ethanschoonover.com/solarized).

export type ThemeMode = 'light' | 'dark';

export interface Palette {
  bg: string;          // layout backdrop
  panel: string;       // container / table surface
  panelRaised: string; // container headers, inputs, buttons
  hairline: string;    // borders and dividers
  hover: string;       // row / item hover
  shaded: string;      // shaded table cells
  ink: string;         // primary text
  dim: string;         // secondary text, column headers
  accent: string;      // primary buttons
  accentSoft: string;  // links, focus ring, accent text
  accentInk: string;   // text on primary buttons
}

export interface ColorTheme {
  id: string;
  label: string;
  mode: ThemeMode;
  palette?: Palette;
}

export const COLOR_THEMES: ColorTheme[] = [
  { id: 'light', label: 'Light', mode: 'light' },
  {
    // Lighter slate greys than stock Cloudscape dark (#0f1b2a backdrop).
    id: 'dark', label: 'Dark', mode: 'dark',
    palette: {
      bg: '#262d38', panel: '#2f3743', panelRaised: '#38414f', hairline: '#4a5464',
      hover: '#3f4958', shaded: '#2b323d', ink: '#e8ecf1', dim: '#b4bfcc',
      accent: '#2f6fdb', accentSoft: '#7ab3ff', accentInk: '#ffffff',
    },
  },
  {
    id: 'nord', label: 'Nord (dark, arctic blue)', mode: 'dark',
    palette: {
      bg: '#2e3440', panel: '#3b4252', panelRaised: '#434c5e', hairline: '#4c566a',
      hover: '#4a5367', shaded: '#353c4a', ink: '#eceff4', dim: '#d8dee9',
      accent: '#88c0d0', accentSoft: '#88c0d0', accentInk: '#2e3440',
    },
  },
  {
    id: 'catppuccin', label: 'Catppuccin Frappé (dark, pastel)', mode: 'dark',
    palette: {
      bg: '#292c3c', panel: '#303446', panelRaised: '#414559', hairline: '#51576d',
      hover: '#3c4054', shaded: '#2c3041', ink: '#c6d0f5', dim: '#b5bddc',
      accent: '#8caaee', accentSoft: '#99d1db', accentInk: '#232634',
    },
  },
  {
    id: 'solarized-dark', label: 'Solarized Dark (teal)', mode: 'dark',
    palette: {
      bg: '#002b36', panel: '#073642', panelRaised: '#0e4351', hairline: '#2a5966',
      hover: '#114a59', shaded: '#04303c', ink: '#eee8d5', dim: '#a3b1b1',
      accent: '#3a9ee6', accentSoft: '#5fb0ea', accentInk: '#002b36',
    },
  },
  {
    id: 'solarized-light', label: 'Solarized Light (warm paper)', mode: 'light',
    palette: {
      bg: '#eee8d5', panel: '#fdf6e3', panelRaised: '#f6efdb', hairline: '#d6cfba',
      hover: '#efe8d3', shaded: '#f6efdb', ink: '#073642', dim: '#4f6268',
      accent: '#1a649e', accentSoft: '#1a649e', accentInk: '#ffffff',
    },
  },
];

export const DEFAULT_LIGHT_THEME = 'light';
export const DEFAULT_DARK_THEME = 'dark';

export function getColorTheme(id: string | null | undefined): ColorTheme {
  return COLOR_THEMES.find(t => t.id === id) || COLOR_THEMES[0];
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Cloudscape color tokens. Each value is supplied for BOTH Cloudscape modes:
// applyTheme reads a flat string as the light-mode value only, so a dark theme
// set as a flat value would not repaint once applyMode(Mode.Dark) is active.
export function cloudscapeColorTokens(p: Palette): Record<string, { light: string; dark: string }> {
  const both = (v: string) => ({ light: v, dark: v });
  return {
    colorBackgroundLayoutMain: both(p.bg),
    colorBackgroundHomeHeader: both(p.bg),
    colorBackgroundContainerContent: both(p.panel),
    colorBackgroundContainerHeader: both(p.panelRaised),
    colorBackgroundInputDefault: both(p.panelRaised),
    colorBackgroundDropdownItemDefault: both(p.panelRaised),
    colorBackgroundControlDefault: both(p.panelRaised),
    colorBackgroundSegmentDefault: both(p.panel),
    colorBackgroundCellShaded: both(p.shaded),
    colorBackgroundTableRow: both(p.panel),
    colorBackgroundDropdownItemHover: both(p.hover),
    colorBackgroundButtonNormalDefault: both(p.panelRaised),
    colorBackgroundLayoutToggleDefault: both(p.panelRaised),
    colorBackgroundLayoutPanelContent: both(p.panel),

    colorTextBodyDefault: both(p.ink),
    colorTextHeadingDefault: both(p.ink),
    colorTextHeadingSecondary: both(p.dim),
    colorTextBodySecondary: both(p.dim),
    colorTextColumnHeader: both(p.dim),
    colorTextButtonNormalDefault: both(p.ink),
    colorTextTopNavigationTitle: both(p.ink),

    colorBorderDividerDefault: both(p.hairline),
    colorBorderDividerSecondary: both(p.hairline),
    colorBorderInputDefault: both(p.hairline),
    colorBorderContainerTop: both(p.hairline),
    colorBorderButtonNormalDefault: both(p.hairline),

    colorTextLinkDefault: both(p.accentSoft),
    colorTextInteractiveDefault: both(p.ink),
    colorTextAccent: both(p.accentSoft),
    colorBackgroundButtonPrimaryDefault: both(p.accent),
    colorTextButtonPrimaryDefault: both(p.accentInk),
    colorBackgroundItemSelected: both(rgba(p.accent, 0.2)),
    colorBorderItemFocused: both(p.accentSoft),
  };
}

// Root CSS variables, set on <html> while a palette theme is on. Inline
// style on <html> wins over the `.dark` / `:root` token sets in ui/styles.css,
// so these repaint every website component (shadcn-style tokens), plus the
// hand-styled widgets that read --theme-* (SQL editor).
export function themeCssVars(p: Palette, mode: ThemeMode): Record<string, string> {
  return {
    '--background': p.bg,
    '--foreground': p.ink,
    '--card': p.panel,
    '--card-foreground': p.ink,
    '--popover': p.panelRaised,
    '--popover-foreground': p.ink,
    '--primary': p.accent,
    '--primary-foreground': p.accentInk,
    '--secondary': p.panelRaised,
    '--secondary-foreground': p.ink,
    '--muted': p.panelRaised,
    '--muted-foreground': p.dim,
    '--accent': p.hover,
    '--accent-foreground': p.ink,
    '--border': p.hairline,
    '--input': p.hairline,
    '--ring': p.accentSoft,
    '--sidebar': p.panel,
    '--sidebar-foreground': p.ink,
    '--sidebar-accent': rgba(p.accent, mode === 'dark' ? 0.24 : 0.14),
    '--sidebar-border': p.hairline,

    '--theme-bg': p.bg,
    '--theme-panel': p.panel,
    '--theme-panel-2': p.panelRaised,
    '--theme-line': p.hairline,
    '--theme-hover': p.hover,
    '--theme-ink': p.ink,
    '--theme-dim': p.dim,
  };
}

// Variables for the Modern shell (modern-shell.css), set inline on its root so
// they win over the .modern-dark / .modern-light defaults.
export function modernShellVars(p: Palette, mode: ThemeMode): Record<string, string> {
  return {
    '--bg': p.bg,
    '--panel': p.panel,
    '--panel-2': p.panelRaised,
    '--line': p.hairline,
    '--ink': p.ink,
    '--ink-dim': p.dim,
    '--accent': p.accent,
    '--accent-soft': p.accentSoft,
    '--accent-ink': p.accentInk,
    '--active-pill': rgba(p.accent, mode === 'dark' ? 0.24 : 0.14),
    '--hover': rgba(p.dim, mode === 'dark' ? 0.12 : 0.08),
  };
}
