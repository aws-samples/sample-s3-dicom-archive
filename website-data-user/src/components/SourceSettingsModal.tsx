import { useState } from 'react';
import { Modal, Box, Button, FormField, Multiselect, SpaceBetween } from '@cloudscape-design/components';
import { SourceType } from '../types';
import {
  KnownSource, kindOf, sourceKey,
  SEARCH_FIELD_CATALOGUE, DEFAULT_SEARCH_FIELD_IDS,
  getSearchFields, setSearchFields,
  getFavorites, setFavorites, applyFavoritesToUnconfigured,
  notifyPrefsChanged,
} from './dataUserPrefs';

export interface SourceSettingsTarget {
  id: string;
  name: string;
  type: SourceType;
}

interface Props {
  /** The source to configure, or null when the dialog is closed. */
  target: SourceSettingsTarget | null;
  userId: string;
  /** Every storage/VF the user can access, for "apply as default". */
  knownSources: KnownSource[];
  /** The tool ids this source can offer, with labels, for the Default tools picker. */
  toolCatalogue: { id: string; label: string }[];
  onClose: () => void;
}

/**
 * Focused per-source settings, opened from the cog on a storage/virtual-folder
 * tab. Shows ONLY that source's own settings — which search fields appear, and
 * which tools are pinned — plus a button to seed those pinned tools onto every
 * other source the user has not configured. Global settings (theme, default app
 * per modality) stay in the main Preferences modal. Writes fire
 * notifyPrefsChanged so the open study tab updates live.
 */
export default function SourceSettingsModal({ target, userId, knownSources, toolCatalogue, onClose }: Props) {
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  // Re-render after a write so the Multiselects reflect the new stored value.
  const [, setTick] = useState(0);
  const bump = () => setTick(t => t + 1);

  if (!target) return null;
  const sk = sourceKey(userId, kindOf(target.type), target.id);
  const searchFields = getSearchFields(sk) ?? DEFAULT_SEARCH_FIELD_IDS;
  const favorites = getFavorites(userId, sk);

  return (
    <Modal
      visible
      onDismiss={onClose}
      header={`Settings for "${target.name}"`}
      footer={<Box float="right"><Button variant="primary" onClick={onClose}>Close</Button></Box>}
    >
      <SpaceBetween size="m">
        <FormField
          label="Search fields"
          description="Which search fields show in the study search form for this storage or folder. Saved per source in your browser."
        >
          <Multiselect
            selectedOptions={searchFields.map(id => ({
              value: id, label: SEARCH_FIELD_CATALOGUE.find(f => f.id === id)?.label || id,
            }))}
            placeholder="No search fields"
            options={SEARCH_FIELD_CATALOGUE.map(f => ({ value: f.id, label: f.label }))}
            onChange={({ detail }) => {
              const ids = detail.selectedOptions.map(o => o.value as string);
              const ordered = DEFAULT_SEARCH_FIELD_IDS.filter(id => ids.includes(id));
              setSearchFields(sk, ordered);
              notifyPrefsChanged(sk);
              bump();
            }}
          />
        </FormField>

        <FormField
          label="Default tools"
          description="Tools pinned beside the Tools button for this storage or folder. Saved per source in your browser."
        >
          <SpaceBetween size="s">
            <Multiselect
              selectedOptions={favorites.map(id => ({
                value: id, label: toolCatalogue.find(t => t.id === id)?.label || id,
              }))}
              placeholder="No pinned tools"
              options={toolCatalogue.map(t => ({ value: t.id, label: t.label }))}
              onChange={({ detail }) => {
                const ids = detail.selectedOptions.map(o => o.value as string);
                setFavorites(sk, ids);
                notifyPrefsChanged(sk);
                bump();
              }}
            />
            <SpaceBetween size="xs" direction="horizontal" alignItems="center">
              <Button
                iconName="status-positive"
                disabled={knownSources.length === 0}
                onClick={() => {
                  const n = applyFavoritesToUnconfigured(userId, favorites, knownSources);
                  notifyPrefsChanged(null);
                  setApplyMsg(n === 0
                    ? 'Every other source already has its own tool settings.'
                    : `Applied to ${n} source${n === 1 ? '' : 's'} that had no tool settings yet.`);
                }}
              >
                Apply these as the default for other sources
              </Button>
              {applyMsg && <Box variant="small" color="text-status-inactive">{applyMsg}</Box>}
            </SpaceBetween>
          </SpaceBetween>
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}
