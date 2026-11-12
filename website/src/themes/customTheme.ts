// Cloudscape themes applied via applyTheme().
//
//  - customThemeConfig : the always-on baseline (reduced 2px corner radius,
//                        standard Cloudscape colors).
//  - modernShapeTokens : the Modern skin's rounded shape and font.
// Color themes live in themes/palettes.ts.

// All token names below are verified to exist in
// @cloudscape-design/components/internal/generated/theming (TypedOverride),
// which is the exact set applyTheme() accepts for this version (3.0.1350).

export const customThemeConfig = {
  tokens: {
    borderRadiusContainer: '2px',
    borderRadiusButton: '2px',
    borderRadiusInput: '2px',
    borderRadiusDropdown: '2px',
    borderRadiusItem: '2px',
    borderRadiusAlert: '2px',
    borderRadiusFlashbar: '2px',
    borderRadiusPopover: '2px',
    borderRadiusBadge: '4px',
    borderRadiusTokenGroup: '2px',
    borderRadiusTiles: '2px',
  },
};

// ---- Modern skin shape + font ----------------------------------------------
// Applied together with a palette theme (themes/palettes.ts) while the Modern
// navigation skin is selected. Colors come from the palette, not from here.

// A modern, crisp font stack. Inter if the host provides it, else system-ui.
const MODERN_FONT =
  'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export const modernShapeTokens = {
  fontFamilyBase: MODERN_FONT,
  borderRadiusContainer: '12px',
  borderRadiusButton: '10px',
  borderRadiusInput: '10px',
  borderRadiusDropdown: '10px',
  borderRadiusItem: '10px',
  borderRadiusAlert: '12px',
  borderRadiusFlashbar: '12px',
  borderRadiusPopover: '10px',
  borderRadiusBadge: '8px',
  borderRadiusTokenGroup: '10px',
  borderRadiusTiles: '12px',
};
