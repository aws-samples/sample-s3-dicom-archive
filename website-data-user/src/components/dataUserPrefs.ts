import { SourceType } from '../types';

/**
 * Per-user, per-source UI preferences, kept in localStorage (same mechanism as the
 * table column picker and the old flat tool favourites). "Source" = one storage
 * (datastore) OR one virtual folder, told apart by kind so a shared UUID can never
 * collide. Nothing here touches the server, the DB, or DICOMweb.
 *
 * Keys:
 *   dataUserSearchFields-<userId>:<kind>:<sourceId>   ordered enabled search-field ids
 *   dataUserToolFavorites-<userId>:<kind>:<sourceId>  starred tool ids for this source
 *   dataUserToolsOpen-<userId>                         Tools panel open/closed (per-user, NOT per-source)
 */

export type SourceKind = 'storage' | 'vf';

/** The study-level search fields the data-user form supports (shared catalogue). */
export const SEARCH_FIELD_CATALOGUE: { id: string; label: string }[] = [
  { id: 'patientID', label: 'Patient ID' },
  { id: 'patientName', label: 'Patient Name' },
  { id: 'studyDate', label: 'Study Date' },
  { id: 'modality', label: 'Modality' },
  { id: 'accessionNumber', label: 'Accession Number' },
  { id: 'studyDescription', label: 'Study Description' },
  { id: 'referringPhysician', label: 'Referring Physician' },
];
export const DEFAULT_SEARCH_FIELD_IDS = SEARCH_FIELD_CATALOGUE.map(f => f.id);

/**
 * Fired on `window` whenever a per-source preference changes (from the
 * Preferences modal), so an open study tab can re-read its own source's
 * settings live instead of only on mount. `detail` carries the affected
 * source key, or null for a change that may touch many sources (apply-as-default).
 */
export const PREFS_CHANGED_EVENT = 'datauser-prefs-changed';
export function notifyPrefsChanged(sk: string | null): void {
  try {
    window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT, { detail: { sk } }));
  } catch { /* non-browser / SSR */ }
}

/** A source the "apply as default" button can seed: a storage or a virtual folder. */
export interface KnownSource {
  kind: SourceKind;
  id: string;
}

export function kindOf(sourceType: SourceType): SourceKind {
  return sourceType === 'datastore' ? 'storage' : 'vf';
}

/** Stable preference-key suffix for one (user, source). */
export function sourceKey(userId: string, kind: SourceKind, sourceId: string): string {
  return `${userId}:${kind}:${sourceId}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / disabled — preference is best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* Search fields                                                       */
/* ------------------------------------------------------------------ */

const searchFieldsKey = (sk: string) => `dataUserSearchFields-${sk}`;

/** Enabled search-field ids for a source, or null when the user has not configured it. */
export function getSearchFields(sk: string): string[] | null {
  const raw = localStorage.getItem(searchFieldsKey(sk));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : null;
  } catch {
    return null;
  }
}

export function setSearchFields(sk: string, fieldIds: string[]): void {
  writeJson(searchFieldsKey(sk), fieldIds);
}

/* ------------------------------------------------------------------ */
/* Tool favourites (stars), per source                                */
/* ------------------------------------------------------------------ */

const favKey = (sk: string) => `dataUserToolFavorites-${sk}`;
const legacyFavKey = (userId: string) => `dataUserToolFavorites-${userId}`;

export const DEFAULT_FAVORITES = ['ohif'];

/**
 * Starred tool ids for a source. Resolution order:
 *   1. this source's own saved value;
 *   2. one-time fall back to the user's OLD flat favourites (pre per-source), if present;
 *   3. DEFAULT_FAVORITES.
 */
export function getFavorites(userId: string, sk: string): string[] {
  const own = localStorage.getItem(favKey(sk));
  if (own) {
    try {
      const v = JSON.parse(own);
      if (Array.isArray(v)) return v as string[];
    } catch { /* fall through */ }
  }
  const legacy = localStorage.getItem(legacyFavKey(userId));
  if (legacy) {
    try {
      const v = JSON.parse(legacy);
      if (Array.isArray(v)) return v as string[];
    } catch { /* fall through */ }
  }
  return DEFAULT_FAVORITES;
}

export function setFavorites(sk: string, favorites: string[]): void {
  writeJson(favKey(sk), favorites);
}

/** True when this source has its own saved tool settings (used by gap-fill). */
export function hasOwnFavorites(sk: string): boolean {
  return localStorage.getItem(favKey(sk)) !== null;
}

/**
 * "Apply current active tab as default tool settings": write `favorites` as the
 * star set for every known source the user has NOT configured yet. Never
 * overwrites a source that already has its own settings, so it is safe to repeat.
 * Returns how many sources were seeded.
 */
export function applyFavoritesToUnconfigured(
  userId: string,
  favorites: string[],
  knownSources: KnownSource[],
): number {
  let seeded = 0;
  for (const s of knownSources) {
    const sk = sourceKey(userId, s.kind, s.id);
    if (!hasOwnFavorites(sk)) {
      setFavorites(sk, favorites);
      seeded += 1;
    }
  }
  return seeded;
}

/* ------------------------------------------------------------------ */
/* Tools panel open/closed — per user                                  */
/* ------------------------------------------------------------------ */

const openKey = (userId: string) => `dataUserToolsOpen-${userId}`;

export function getToolsOpen(userId: string): boolean {
  return readJson<boolean>(openKey(userId), false);
}

export function setToolsOpen(userId: string, open: boolean): void {
  writeJson(openKey(userId), open);
}
