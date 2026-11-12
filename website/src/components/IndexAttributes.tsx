import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Container, Header, Table, Button, SpaceBetween, Box, Select, FormField,
  Input, Modal, Alert, Badge, Checkbox, Tabs, SegmentedControl, StatusIndicator,
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';
import { AssignmentRulesManagement } from './VirtualFolders/AssignmentRulesManagement';
import DeidProfiles from './IndexAttributesDeid';

type TargetType = 'STORAGE' | 'VF';
type VfOption = { id: string; name: string };

const LEVELS = [
  { value: 'PATIENT', label: 'Patient' },
  { value: 'STUDY', label: 'Study' },
  { value: 'SERIES', label: 'Series' },
  { value: 'INSTANCE', label: 'Instance' },
];
const TYPES = [
  { value: 'STRING', label: 'String' },
  { value: 'INT', label: 'Integer' },
  { value: 'DECIMAL', label: 'Decimal' },
  { value: 'DATE', label: 'Date' },
];

type BadgeColor = 'blue' | 'grey' | 'green' | 'red' | 'severity-critical' | 'severity-high' | 'severity-medium' | 'severity-low' | 'severity-neutral';
function levelColor(level: string): BadgeColor {
  switch ((level || '').toUpperCase()) {
    case 'PATIENT': return 'blue';
    case 'STUDY': return 'green';
    case 'SERIES': return 'severity-medium';
    case 'INSTANCE': return 'red';
    default: return 'grey';
  }
}

// Back-fill of rows indexed before a STORAGE attribute existed (GET /defs
// returns it on each STORAGE def as `backfill`).
type Backfill = {
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'; stalled?: boolean; percent?: number;
  rowsScanned?: number; rowsWritten?: number; error?: string | null; updatedAt?: string | null;
} | null | undefined;
const backfillActive = (b: Backfill) => !!b && (b.status === 'PENDING' || b.status === 'RUNNING') && !b.stalled;

function BackfillCell({ b }: { b: Backfill }) {
  if (!b) return <Box color="text-status-inactive">—</Box>;
  if (b.stalled) return <StatusIndicator type="warning">Stalled at {b.percent ?? 0}% — use Back-fill to resume</StatusIndicator>;
  switch (b.status) {
    case 'PENDING': return <StatusIndicator type="pending">Starting…</StatusIndicator>;
    case 'RUNNING': return <StatusIndicator type="in-progress">{b.percent ?? 0}% ({(b.rowsWritten ?? 0).toLocaleString()} rows)</StatusIndicator>;
    case 'DONE': return <StatusIndicator type="success">Done ({(b.rowsWritten ?? 0).toLocaleString()} rows)</StatusIndicator>;
    case 'FAILED': return <StatusIndicator type="error">{b.error ? `Failed: ${b.error}` : 'Failed'}</StatusIndicator>;
    default: return <Box>{String((b as any).status)}</Box>;
  }
}

export default function IndexAttributes() {
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [warn, setWarn] = useState('');

  // ── Table structure ───────────────────────────────────────────────────────
  // STORAGE = single global structure; VF = per-virtual-folder (needs a VF).
  const [targetType, setTargetType] = useState<TargetType>('STORAGE');
  const [defs, setDefs] = useState<any[]>([]);
  const [defsLoading, setDefsLoading] = useState(false);

  // Virtual-folder selector (VF mode only).
  const [vfOptions, setVfOptions] = useState<VfOption[]>([]);
  const [vf, setVf] = useState<VfOption | null>(null);

  // Sorting for the structure table.
  const [sortingColumn, setSortingColumn] = useState<any>(null);
  const [sortingDescending, setSortingDescending] = useState(false);

  // DICOM tag dictionary (from GET /dicom-tags).
  const [tagDict, setTagDict] = useState<any[]>([]);
  const [selectedTag, setSelectedTag] = useState<any | null>(null);

  // Add-def form.
  const [showAdd, setShowAdd] = useState(false);
  const [columnName, setColumnName] = useState('');
  const [dicomTag, setDicomTag] = useState('');
  const [dicomLevel, setDicomLevel] = useState(LEVELS[1]);
  const [dataType, setDataType] = useState(TYPES[0]);
  const [description, setDescription] = useState('');
  const [isIndexed, setIsIndexed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const resp: any = await apiClient.getDicomTags();
        const list = resp?.data?.dicom_attributes || resp?.dicom_attributes || resp?.data || [];
        setTagDict(Array.isArray(list) ? list : []);
      } catch { /* dictionary optional; manual entry still works */ }
    })();
  }, []);

  const slugify = (kw: string) =>
    (kw || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_')
      .toLowerCase().replace(/^_+|_+$/g, '').slice(0, 64) || 'attr';

  const vrToDataType = (vr: string) => {
    const DATE = ['DA', 'DT', 'TM'];
    const INT = ['IS', 'US', 'UL', 'SS', 'SL', 'UV', 'SV'];
    const DECIMAL = ['FL', 'FD'];
    if (DATE.includes(vr)) return TYPES.find(t => t.value === 'DATE')!;
    if (INT.includes(vr)) return TYPES.find(t => t.value === 'INT')!;
    if (DECIMAL.includes(vr)) return TYPES.find(t => t.value === 'DECIMAL')!;
    return TYPES.find(t => t.value === 'STRING')!;
  };

  const onPickTag = (opt: any) => {
    const t = tagDict.find(x => x.tag === opt.value || x.tag.replace(',', '') === opt.value);
    setSelectedTag(opt);
    if (!t) return;
    setDicomTag(t.tag.replace(',', '').toUpperCase());
    setColumnName(slugify(t.keyword));
    const lvl = (t.level || '').toUpperCase();
    setDicomLevel(LEVELS.find(l => l.value === lvl) || LEVELS[1]);
    setDataType(vrToDataType(t.vr));
  };

  // Load virtual folders for the VF selector.
  useEffect(() => {
    (async () => {
      try {
        const vfResp = await apiClient.getVirtualFolders({ page: 1, pageSize: 100 } as any);
        const vfItems = (vfResp as any)?.data?.items || (vfResp as any)?.data || [];
        const opts: VfOption[] = [];
        for (const f of vfItems) if (f?.id) opts.push({ id: f.id, name: f.name });
        setVfOptions(opts);
      } catch { /* VF feature may be disabled */ }
    })();
  }, []);

  // A VF-mode load needs a selected VF; STORAGE mode is always ready.
  const vfSelectedInVfMode = targetType !== 'VF' || !!vf;

  const loadDefs = useCallback(async (tt: TargetType, virtualFolderId?: string) => {
    setDefsLoading(true);
    try {
      const resp: any = await apiClient.listIndexAttributeDefs(tt, virtualFolderId);
      const custom = (resp?.data?.data || resp?.data || []).map((a: any) => ({ ...a, builtin: false }));
      const builtins = (resp?.builtins || resp?.data?.builtins || []).map((b: any) => ({ ...b, builtin: true }));
      setDefs([...(Array.isArray(builtins) ? builtins : []), ...(Array.isArray(custom) ? custom : [])]);
    } catch (e: any) { setError(e.message || 'Failed to load table structure'); setDefs([]); }
    finally { setDefsLoading(false); }
  }, []);

  // Load defs when STORAGE mode, or VF mode with a VF selected. In VF mode with
  // no VF selected, do NOT call the API (it 400s without virtualFolderId).
  useEffect(() => {
    if (targetType === 'STORAGE') { loadDefs('STORAGE'); }
    else if (vf) { loadDefs('VF', vf.id); }
    else { setDefs([]); }
  }, [targetType, vf, loadDefs]);

  const addDef = async () => {
    setSaving(true); setError('');
    try {
      const resp: any = await apiClient.createIndexAttributeDef({
        targetType,
        ...(targetType === 'VF' && vf ? { virtualFolderId: vf.id } : {}),
        columnName: columnName.trim(), dicomTag: dicomTag.trim(),
        dicomLevel: dicomLevel.value, dataType: dataType.value,
        isIndexed,
        description: description.trim() || undefined,
      });
      const warning = resp?.warning || resp?.data?.warning;
      const where = targetType === 'VF' && vf ? `${vf.name} virtual-folder` : 'storage';
      if (warning) { setWarn(warning); }
      else { setWarn(''); }
      setSuccess(`Added '${columnName}' to the ${where} table structure.` +
        (targetType === 'STORAGE' ? ' Existing studies are being back-filled from their stored headers (progress in the Back-fill column).' : ''));
      setShowAdd(false);
      setColumnName(''); setDicomTag(''); setDescription(''); setSelectedTag(null);
      if (targetType === 'STORAGE') await loadDefs('STORAGE');
      else if (vf) await loadDefs('VF', vf.id);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to add attribute');
    } finally { setSaving(false); }
  };

  const runBackfill = async (a: any) => {
    setError('');
    try {
      const resp: any = await apiClient.backfillIndexAttributeDef(a.id);
      const resumed = resp?.data?.resumed ?? resp?.data?.data?.resumed;
      setSuccess(`${resumed ? 'Resumed' : 'Started'} the back-fill of '${a.label || a.columnName}' from the stored DICOM headers.`);
      if (targetType === 'STORAGE') await loadDefs('STORAGE');
    } catch (e: any) { setError(e.response?.data?.error || e.message || 'Failed to start the back-fill'); }
  };

  // Refresh progress while a STORAGE back-fill is running.
  const anyBackfillActive = targetType === 'STORAGE' && defs.some(d => !d.builtin && backfillActive(d.backfill));
  useEffect(() => {
    if (!anyBackfillActive) return undefined;
    const t = setInterval(() => { loadDefs('STORAGE'); }, 10000);
    return () => clearInterval(t);
  }, [anyBackfillActive, loadDefs]);

  const removeDef = async (a: any) => {
    try {
      await apiClient.deleteIndexAttributeDef(a.id);
      setSuccess(`Removed '${a.label || a.columnName}' from the table structure. The physical column was left in place.`);
      if (targetType === 'STORAGE') await loadDefs('STORAGE');
      else if (vf) await loadDefs('VF', vf.id);
    } catch (e: any) { setError(e.response?.data?.error || e.message || 'Failed to remove attribute'); }
  };

  const valid = /^[a-z][a-z0-9_]{0,63}$/.test(columnName.trim()) && /^[0-9A-Fa-f]{8}$/.test(dicomTag.trim());

  const LEVEL_ORDER: Record<string, number> = { PATIENT: 0, STUDY: 1, SERIES: 2, INSTANCE: 3 };
  const sortValue = (a: any, field: string): string | number => {
    switch (field) {
      case 'columnName': return (a.label || a.columnName || '').toLowerCase();
      case 'source': return a.builtin ? 0 : 1;
      case 'dicomTag': return (a.dicomTag || '').toLowerCase();
      case 'dicomLevel': return LEVEL_ORDER[(a.dicomLevel || '').toUpperCase()] ?? 99;
      case 'dataType': return (a.dataType || '').toLowerCase();
      case 'indexed': return a.isIndexed ? 1 : 0;
      default: return '';
    }
  };

  const sortedDefs = useMemo(() => {
    const field = sortingColumn?.sortingField;
    if (!field) return defs;
    const sorted = [...defs].sort((x, y) => {
      const vx = sortValue(x, field);
      const vy = sortValue(y, field);
      if (vx < vy) return -1;
      if (vx > vy) return 1;
      return 0;
    });
    return sortingDescending ? sorted.reverse() : sorted;
  }, [defs, sortingColumn, sortingDescending]);

  // ── Table structure render ────────────────────────────────────────────────
  const tableStructureTab = (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2"
        description="Which DICOM attributes exist as columns on the tables, their level, type, and whether they carry a database index. Storage structure is a single global structure shared by every datastore. Virtual-folder structure is per-virtual-folder — each VF starts from the standard DICOM base plus its own added columns. Every defined column is populated by ingestion unconditionally; a new storage attribute is also back-filled for existing studies from their stored headers.">
        Table structure</Header>}>
        <SpaceBetween size="m">
          <SegmentedControl
            selectedId={targetType}
            onChange={({ detail }) => setTargetType(detail.selectedId as TargetType)}
            options={[
              { id: 'STORAGE', text: 'Storage structure' },
              { id: 'VF', text: 'Virtual-folder structure' },
            ]}
          />
          {targetType === 'VF' && (
            <FormField label="Virtual folder" description="Choose the virtual folder whose custom columns you want to view or edit.">
              <Select
                selectedOption={vf ? { value: vf.id, label: vf.name } : null}
                onChange={({ detail }) => {
                  const found = vfOptions.find(o => o.id === detail.selectedOption.value);
                  setVf(found || null);
                }}
                options={vfOptions.map(o => ({ value: o.id, label: o.name }))}
                placeholder="Select a virtual folder"
                filteringType="auto"
                empty="No virtual folders"
              />
            </FormField>
          )}
        </SpaceBetween>
      </Container>

      {targetType === 'VF' && !vf ? (
        <Container>
          <Box textAlign="center" color="inherit" padding="l">
            <b>Select a virtual folder</b>
            <Box variant="p" color="inherit">Pick a virtual folder above to view and edit its table structure.</Box>
          </Box>
        </Container>
      ) : (
        <Table
          header={
            <Header variant="h2" counter={`(${defs.length})`}
              description="Built-in columns are standard DICOM fields already on the tables (read-only). Custom attributes are ones you add; the index/type decision is made here."
              actions={
                <Button variant="primary" iconName="add-plus"
                  onClick={() => { setSelectedTag(null); setColumnName(''); setDicomTag(''); setDescription(''); setDicomLevel(LEVELS[1]); setDataType(TYPES[0]); setIsIndexed(false); setShowAdd(true); }}>
                  Add attribute
                </Button>}
            >{targetType === 'VF' ? `Virtual-folder columns — ${vf?.name}` : 'Storage table columns'}</Header>
          }
          loading={defsLoading}
          items={sortedDefs}
          sortingColumn={sortingColumn}
          sortingDescending={sortingDescending}
          onSortingChange={({ detail }) => { setSortingColumn(detail.sortingColumn); setSortingDescending(detail.isDescending ?? false); }}
          columnDefinitions={[
            { id: 'columnName', header: 'Attribute', sortingField: 'columnName', cell: (a: any) => <Box variant="code">{a.label || a.columnName}</Box> },
            { id: 'source', header: 'Source', sortingField: 'source', cell: (a: any) => (a.builtin ? <Badge color="grey">Built-in</Badge> : <Badge color="blue">Custom</Badge>) },
            { id: 'dicomTag', header: 'DICOM tag', sortingField: 'dicomTag', cell: (a: any) => <Box variant="code">{a.dicomTag || '—'}</Box> },
            { id: 'dicomLevel', header: 'Level', sortingField: 'dicomLevel', cell: (a: any) => <Badge color={levelColor(a.dicomLevel)}>{a.dicomLevel}</Badge> },
            { id: 'dataType', header: 'Type', sortingField: 'dataType', cell: (a: any) => a.dataType || '—' },
            { id: 'indexed', header: 'Indexed', sortingField: 'indexed', cell: (a: any) => (a.isIndexed ? <Badge color="green">Indexed</Badge> : <Box color="text-status-inactive">Not indexed</Box>) },
            ...(targetType === 'STORAGE' ? [{
              id: 'backfill', header: 'Back-fill',
              cell: (a: any) => (a.builtin ? <Box color="text-status-inactive">—</Box> : <BackfillCell b={a.backfill} />),
            }] : []),
            {
              id: 'actions', header: 'Actions',
              cell: (a: any) => (a.builtin ? <Box color="text-status-inactive">Read-only</Box> : (
                <SpaceBetween direction="horizontal" size="xs">
                  {targetType === 'STORAGE' && (
                    <Button variant="normal" iconName="refresh" disabled={backfillActive(a.backfill)}
                      onClick={() => runBackfill(a)}>Back-fill</Button>
                  )}
                  <Button variant="normal" iconName="remove" onClick={() => removeDef(a)}>Delete</Button>
                </SpaceBetween>
              )),
            },
          ]}
          empty={<Box textAlign="center" color="inherit" padding="l"><b>No custom attributes</b><Box variant="p" color="inherit">Add a DICOM tag to define a column on these tables.</Box></Box>}
        />
      )}
    </SpaceBetween>
  );

  // VF-only Assignment Rules / De-id tabs appear when a VF is selected in the
  // Table-structure VF selector (they are per-VF configuration).
  const vfTabs = (targetType === 'VF' && vf) ? [
    { id: 'rules', label: 'Assignment Rules', content: <AssignmentRulesManagement virtualFolderId={vf.id} onClose={() => {}} /> },
    { id: 'deid', label: 'De-id Profiles', content: <DeidProfiles /> },
  ] : [];

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="Define which DICOM tags exist as columns on the index tables. Storage structure is one global structure; virtual-folder structure is per-VF. Every defined column is populated by ingestion.">
        Searchable Attributes
      </Header>
      {error && <Alert type="error" dismissible onDismiss={() => setError('')}>{error}</Alert>}
      {warn && <Alert type="warning" dismissible onDismiss={() => setWarn('')}>{warn}</Alert>}
      {success && <Alert type="success" dismissible onDismiss={() => setSuccess('')}>{success}</Alert>}

      <Tabs
        tabs={[
          { id: 'structure', label: 'Table structure', content: tableStructureTab },
          ...vfTabs,
        ]}
      />

      <Modal
        visible={showAdd}
        onDismiss={() => setShowAdd(false)}
        header={`Add index attribute (${targetType === 'VF' ? `${vf?.name} virtual folder` : 'storage tables'})`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button variant="primary" loading={saving} disabled={!valid || saving || !vfSelectedInVfMode} onClick={addDef}>Add</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="DICOM attribute" description="Search the DICOM dictionary by name, keyword, or tag. Selecting one fills in the column, level and type — you can override them below.">
            <Select
              selectedOption={selectedTag}
              onChange={({ detail }) => onPickTag(detail.selectedOption)}
              options={tagDict.slice(0, 2000).map((t: any) => ({
                value: t.tag.replace(',', ''),
                label: `${t.name} (${t.tag})`,
                description: `${t.keyword} · ${t.vr} · ${(t.level || '').toUpperCase()}`,
              }))}
              filteringType="auto"
              placeholder="Search DICOM attributes (e.g. Body Part, Modality, 00180015)"
              empty="No matching DICOM attributes"
              virtualScroll
            />
          </FormField>
          <FormField label="Column name" description="A human-readable label for this attribute. The physical database column is the DICOM keyword (matching the standard tag columns)."
            errorText={columnName && !/^[a-z][a-z0-9_]{0,63}$/.test(columnName.trim()) ? 'Must match ^[a-z][a-z0-9_]{0,63}$' : undefined}>
            <Input value={columnName} onChange={({ detail }) => setColumnName(detail.value)} placeholder="e.g. body_part_examined" />
          </FormField>
          <FormField label="DICOM tag"
            errorText={dicomTag && !/^[0-9A-Fa-f]{8}$/.test(dicomTag.trim()) ? 'Must be 8 hex characters' : undefined}>
            <Input value={dicomTag} onChange={({ detail }) => setDicomTag(detail.value)} placeholder="e.g. 00180015" disabled={!!selectedTag} />
          </FormField>
          <FormField label="Level" description="Auto-proposed from the attribute; override if needed.">
            <Select selectedOption={dicomLevel} onChange={({ detail }) => setDicomLevel(detail.selectedOption as any)} options={LEVELS} />
          </FormField>
          <FormField label="Data type" description="Auto-proposed from the attribute's VR; override if needed.">
            <Select selectedOption={dataType} onChange={({ detail }) => setDataType(detail.selectedOption as any)} options={TYPES} />
          </FormField>
          <FormField label="Indexed" description="Create a database index on this column to speed up filtering/sorting. If the table has reached MySQL's 64-index limit, the column is still created but without an index (you'll see a warning).">
            <Checkbox checked={isIndexed} onChange={({ detail }) => setIsIndexed(detail.checked)}>Create a database index on this column</Checkbox>
          </FormField>
          <FormField label="Description (optional)">
            <Input value={description} onChange={({ detail }) => setDescription(detail.value)} />
          </FormField>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
