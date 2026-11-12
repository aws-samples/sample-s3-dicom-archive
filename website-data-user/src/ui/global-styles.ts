/**
 * Stand-in for @cloudscape-design/global-styles. Light/dark is the `dark`
 * class on <html>, which switches the tokens in ui/styles.css. Density is a
 * data attribute the kit can key off.
 */
export enum Mode { Light = 'light', Dark = 'dark' }
export enum Density { Comfortable = 'comfortable', Compact = 'compact' }
export function applyMode(mode: Mode, target: HTMLElement = document.documentElement) {
  target.classList.toggle('dark', mode === Mode.Dark);
}
export function applyDensity(density: Density, target: HTMLElement = document.documentElement) {
  target.dataset.density = density;
}
export function disableMotion(disabled: boolean, target: HTMLElement = document.documentElement) {
  target.dataset.reducedMotion = disabled ? 'true' : 'false';
}
