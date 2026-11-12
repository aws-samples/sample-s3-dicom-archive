import { useState, useEffect, useMemo } from 'react';
import { Button } from '@cloudscape-design/components';
import { Star, ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import {
  getFavorites,
  setFavorites as persistFavorites,
  getToolsOpen,
  setToolsOpen,
  notifyPrefsChanged,
  PREFS_CHANGED_EVENT,
} from './dataUserPrefs';

/**
 * One launchable tool on the study table (a viewer, Download, VolView, Attach files).
 * `multi` says whether the tool can take several selected studies in one launch.
 */
export interface StudyTool {
  id: string;
  label: string;
  iconName?: string;
  multi: boolean;
  loading?: boolean;
  run: () => void;
}

interface ToolsPanelProps {
  tools: StudyTool[];
  selectedCount: number;
  /** Per-user key, so two people sharing a browser keep their own favourites. */
  userId: string;
  /** Preference-key suffix for THIS source (storage or virtual folder). */
  sourceKey: string;
}

/** Why a tool cannot be launched for the current selection, or null when it can. */
export function toolDisabledReason(tool: StudyTool, selectedCount: number): string | null {
  if (selectedCount === 0) return 'Select a study first';
  if (!tool.multi && selectedCount > 1) return `${tool.label} opens one study at a time`;
  return null;
}

function ToolButton({ tool, selectedCount }: { tool: StudyTool; selectedCount: number }) {
  const reason = toolDisabledReason(tool, selectedCount);
  // The kit Button has no title prop, so the reason is shown on a wrapper.
  return (
    <span title={reason || undefined} className="inline-flex">
      <Button iconName={tool.iconName} disabled={!!reason} loading={tool.loading} onClick={tool.run}>
        {tool.label}
      </Button>
    </span>
  );
}

/**
 * Study-table tool bar: favourite (starred) tools stay visible as buttons, and a
 * collapsible "Tools" container lists every tool with a star to pin it.
 * Favourites are kept per user AND per source (this storage/virtual folder); the
 * panel's open/closed state is kept per user. Choosing a per-source default set,
 * and applying it to other sources, is done from the Preferences modal — this
 * panel re-reads those changes live (PREFS_CHANGED_EVENT) so the two stay in sync.
 */
export default function ToolsPanel({ tools, selectedCount, userId, sourceKey }: ToolsPanelProps) {
  const [favorites, setFavorites] = useState<string[]>(() => getFavorites(userId, sourceKey));
  const [open, setOpen] = useState<boolean>(() => getToolsOpen(userId));

  // Reload this source's favourites on source (tab) switch.
  useEffect(() => { setFavorites(getFavorites(userId, sourceKey)); }, [userId, sourceKey]);

  // React to changes made in the Preferences modal (this source, or a broad apply).
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sk: string | null } | undefined;
      if (!detail || detail.sk === null || detail.sk === sourceKey) {
        setFavorites(getFavorites(userId, sourceKey));
      }
    };
    window.addEventListener(PREFS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PREFS_CHANGED_EVENT, onChange);
  }, [userId, sourceKey]);

  useEffect(() => { setToolsOpen(userId, open); }, [userId, open]);

  const starred = useMemo(() => tools.filter(t => favorites.includes(t.id)), [tools, favorites]);
  const toggleStar = (id: string) =>
    setFavorites(f => {
      const next = f.includes(id) ? f.filter(x => x !== id) : [...f, id];
      persistFavorites(sourceKey, next);
      notifyPrefsChanged(sourceKey); // keep the Preferences modal in sync
      return next;
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="study-tools-container"
          onClick={() => setOpen(o => !o)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-secondary"
        >
          {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
          <Wrench size={15} aria-hidden />
          Tools
          <span className="text-xs text-muted-foreground">({tools.length})</span>
        </button>
        {starred.map(t => <ToolButton key={t.id} tool={t} selectedCount={selectedCount} />)}
      </div>

      {open && (
        <div
          id="study-tools-container"
          role="region"
          aria-label="Tools"
          className="rounded-lg border border-border bg-card p-3 text-card-foreground"
        >
          <div className="mb-2 text-xs text-muted-foreground">
            Star a tool to keep it next to the Tools button. Stars are saved for this storage or folder, and can also be set from the tab's settings cog.
            {selectedCount > 1 && ' Tools that open one study at a time are disabled while several studies are selected.'}
          </div>
          <ul className="flex flex-wrap gap-2">
            {tools.map(t => {
              const isFav = favorites.includes(t.id);
              return (
                <li key={t.id} className="flex items-center gap-1 rounded-md border border-border bg-background px-1 py-1">
                  <button
                    type="button"
                    aria-pressed={isFav}
                    aria-label={isFav ? `Remove ${t.label} from favourites` : `Add ${t.label} to favourites`}
                    title={isFav ? 'Remove from favourites' : 'Add to favourites'}
                    onClick={() => toggleStar(t.id)}
                    className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <Star size={16} aria-hidden className={isFav ? 'fill-current text-warning' : ''} />
                  </button>
                  <ToolButton tool={t} selectedCount={selectedCount} />
                  {!t.multi && <span className="pr-1 text-xs text-muted-foreground">1 study</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
