import React, { createContext, useContext, useState, useEffect } from 'react';
import { Mode } from '@cloudscape-design/global-styles';
import { applyTheme } from '@cloudscape-design/components/theming';
import { customThemeConfig, modernShapeTokens } from '../themes/customTheme';
import {
  ColorTheme, COLOR_THEMES, DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME,
  cloudscapeColorTokens, getColorTheme, themeCssVars,
} from '../themes/palettes';

// customTheme stays the light/dark MODE (existing toggles, dark-mode CSS and
// Cloudscape applyMode key off it). colorTheme is the palette chosen in
// Settings -> Appearance; its mode decides customTheme.
export type CustomTheme = 'light' | 'dark';
export type NavSkin = 'classic' | 'modern';

interface ThemeContextType {
  theme: Mode;
  customTheme: CustomTheme;
  setCustomTheme: (theme: CustomTheme) => void;
  toggleTheme: () => void;
  colorTheme: ColorTheme;
  setColorTheme: (id: string) => void;
  colorThemes: ColorTheme[];
  navSkin: NavSkin;
  setNavSkin: (skin: NavSkin) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: Mode.Light,
  customTheme: 'light',
  setCustomTheme: () => {},
  toggleTheme: () => {},
  colorTheme: COLOR_THEMES[0],
  setColorTheme: () => {},
  colorThemes: COLOR_THEMES,
  navSkin: 'classic',
  setNavSkin: () => {},
});

export const useTheme = () => useContext(ThemeContext);

// First load after this change: the old 'theme' key held only light/dark.
function initialColorThemeId(): string {
  const saved = localStorage.getItem('colorTheme');
  if (saved && COLOR_THEMES.some(t => t.id === saved)) return saved;
  // The previous data-user UI stored light/dark as darkMode=true|false.
  const dark = localStorage.getItem('theme') === 'dark' || localStorage.getItem('darkMode') === 'true';
  return dark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [colorThemeId, setColorThemeId] = useState<string>(initialColorThemeId);
  const colorTheme = getColorTheme(colorThemeId);
  const customTheme: CustomTheme = colorTheme.mode;
  const theme = customTheme === 'dark' ? Mode.Dark : Mode.Light;

  // The Navigation style preference was removed from website; always use
  // classic so a previously stored 'modern' cannot stick with no way back.
  const [navSkin, setNavSkinState] = useState<NavSkin>(() => {
    return 'classic';
  });

  // Baseline Cloudscape theme (2px corners), applied once.
  useEffect(() => {
    try {
      applyTheme({ theme: customThemeConfig as any });
    } catch (e) {
      console.warn('applyTheme failed:', e);
    }
  }, []);

  // Persist the choice, and remember the last light and last dark theme so the
  // top-bar sun/moon toggle returns to them instead of the defaults.
  useEffect(() => {
    localStorage.setItem('colorTheme', colorTheme.id);
    localStorage.setItem('theme', customTheme);
    localStorage.setItem(customTheme === 'dark' ? 'lastDarkTheme' : 'lastLightTheme', colorTheme.id);
    document.body.dataset.awsuiTheme = customTheme;
    if (colorTheme.palette) document.body.dataset.colorTheme = colorTheme.id;
    else delete document.body.dataset.colorTheme;

    const root = document.documentElement;
    const vars = colorTheme.palette ? themeCssVars(colorTheme.palette, colorTheme.mode) : {};
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
    return () => { Object.keys(vars).forEach(k => root.style.removeProperty(k)); };
  }, [colorTheme, customTheme]);

  // Palette overlay on top of the baseline. A palette theme repaints every
  // Cloudscape surface; the Modern skin adds its rounded shape and font only
  // with a palette theme, as before (Modern + stock light stays stock).
  // The handle's reset() rolls the overlay back when the theme or skin changes.
  useEffect(() => {
    localStorage.setItem('navSkin', navSkin);
    document.body.classList.toggle('nav-skin-b', navSkin === 'modern');

    let handle: { reset: () => void } | undefined;
    if (colorTheme.palette) {
      const tokens = {
        ...(navSkin === 'modern' ? modernShapeTokens : {}),
        ...cloudscapeColorTokens(colorTheme.palette),
      };
      try {
        handle = applyTheme({ theme: { tokens } as any });
      } catch (e) {
        console.warn(`applyTheme(${colorTheme.id}) failed:`, e);
      }
    }
    return () => {
      try {
        handle?.reset();
      } catch (e) {
        console.warn('theme overlay reset failed:', e);
      }
    };
  }, [navSkin, colorTheme]);

  const setColorTheme = (id: string) => setColorThemeId(getColorTheme(id).id);

  const setCustomTheme = (mode: CustomTheme) => {
    if (mode === customTheme) return;
    const remembered = localStorage.getItem(mode === 'dark' ? 'lastDarkTheme' : 'lastLightTheme');
    const fallback = mode === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
    const target = getColorTheme(remembered);
    setColorThemeId(remembered && target.id === remembered && target.mode === mode ? remembered : fallback);
  };

  const toggleTheme = () => setCustomTheme(customTheme === 'dark' ? 'light' : 'dark');

  const setNavSkin = (skin: NavSkin) => {
    setNavSkinState(skin);
  };

  return (
    <ThemeContext.Provider value={{
      theme, customTheme, setCustomTheme, toggleTheme,
      colorTheme, setColorTheme, colorThemes: COLOR_THEMES,
      navSkin, setNavSkin,
    }}>
      {children}
    </ThemeContext.Provider>
  );
};
