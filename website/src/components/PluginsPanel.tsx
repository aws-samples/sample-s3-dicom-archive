import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Table, Button, Header, SpaceBetween, Box, Modal, Alert, Badge, StatusIndicator,
  Textarea, ColumnLayout, ExpandableSection, Link, Toggle,
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';
import { usePrivileges } from '../hooks/usePrivileges';

interface Plugin {
  id: string; name: string; description: string | null; enabled: boolean;
  manifest: any; jobDefinitionArn: string | null; createdAt: string; createdBy: string;
}

const TEMPLATE = (prefix: string, registry: string) => JSON.stringify({
  name: 'My plugin',
  description: 'What this plugin does to each series',
  image: `${registry || '<account>.dkr.ecr.<region>.amazonaws.com'}/${prefix || '<prefix>'}-plugin-myplugin:1.0.0`,
  architecture: 'X86_64',
  granularity: 'series',
  resources: { vcpu: 1, memoryMiB: 2048, timeoutMinutes: 30 },
  maxSteps: 500,
  parameters: [
    { name: 'threshold', type: 'number', label: 'Threshold', default: 0.5, min: 0, max: 1 },
    { name: 'mode', type: 'enum', label: 'Mode', options: ['fast', 'accurate'], default: 'fast' },
  ],
}, null, 2);

/**
 * Register and manage processing-job plugins. A plugin is a container image
 * plus a manifest; once registered it appears next to the built-in jobs and is
 * run from a selection on the DICOM Studies or Analytics screen.
 */
export default function PluginsPanel({ onChanged }: { onChanged?: (silent?: boolean) => void }) {
  const { hasManagementAccess } = usePrivileges();
  const canManage = hasManagementAccess('processingJobs', 'canCreate');
  const canDelete = hasManagementAccess('processingJobs', 'canDelete');

  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Plugin[]>([]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Plugin | null>(null);
  const [text, setText] = useState('');
  const [validation, setValidation] = useState<{ valid: boolean; errors: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const timer = useRef<number | undefined>(undefined);

  // silent=true refreshes in place (no loading state), for refreshes that follow
  // an action the user already sees the result of.
  const load = useCallback(async (silent?: boolean) => {
    if (silent !== true) setLoading(true);
    try {
      const resp = await apiClient.makeRequest<Plugin[]>('/processing-jobs/plugins');
      setPlugins(resp.data || []);
    } catch (e: any) { setError(e.message); }
    if (silent !== true) setLoading(false);
  }, []);
  const [pending, setPending] = useState<Set<string>>(new Set());
  useEffect(() => { load(); }, [load]);

  // Live validation against the server, debounced, so the operator sees the
  // same errors registration would return before pressing Save.
  useEffect(() => {
    if (!editorOpen) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      let manifest: any;
      try { manifest = JSON.parse(text); } catch (e: any) {
        setValidation({ valid: false, errors: [`Not valid JSON: ${e.message}`] }); return;
      }
      try {
        const resp = await apiClient.makeRequest<any>('/processing-jobs/plugins/validate', {
          method: 'POST', body: JSON.stringify({ manifest }),
        });
        setValidation({ valid: !!resp.data?.valid, errors: resp.data?.errors || [] });
      } catch (e: any) { setValidation({ valid: false, errors: [e.message] }); }
    }, 400);
    return () => window.clearTimeout(timer.current);
  }, [text, editorOpen]);

  const openNew = () => {
    const prefix = (plugins[0]?.jobDefinitionArn || '').match(/job-definition\/([a-z0-9-]+?)-plugin-/)?.[1] || '';
    // This account's ECR registry host, taken from any registered image.
    const registry = (plugins.find(p => p.manifest?.image)?.manifest.image || '').split('/')[0];
    setEditing(null); setText(TEMPLATE(prefix, /\.dkr\.ecr\./.test(registry) ? registry : '')); setSaveError(''); setValidation(null); setEditorOpen(true);
  };
  const openEdit = (p: Plugin) => {
    setEditing(p); setText(JSON.stringify(p.manifest, null, 2)); setSaveError(''); setValidation(null); setEditorOpen(true);
  };

  const save = async () => {
    setSaving(true); setSaveError('');
    try {
      const manifest = JSON.parse(text);
      await apiClient.makeRequest(editing ? `/processing-jobs/plugins/${editing.id}` : '/processing-jobs/plugins', {
        method: editing ? 'PUT' : 'POST', body: JSON.stringify({ manifest }),
      });
      setEditorOpen(false); await load(true); onChanged?.(true);
    } catch (e: any) { setSaveError(e.message); }
    setSaving(false);
  };

  // Optimistic: flip the switch at once, lock it until the API answers, and
  // put it back if the call fails. No table or page reload.
  const toggle = async (p: Plugin) => {
    const next = !p.enabled;
    const setEnabled = (v: boolean) => setPlugins(list => list.map(x => (x.id === p.id ? { ...x, enabled: v } : x)));
    setEnabled(next);
    setPending(s => new Set(s).add(p.id));
    try {
      await apiClient.makeRequest(`/processing-jobs/plugins/${p.id}/${next ? 'enable' : 'disable'}`, { method: 'POST' });
      onChanged?.(true);
    } catch (e: any) {
      setEnabled(p.enabled);
      setError(e.message);
    } finally {
      setPending(s => { const n = new Set(s); n.delete(p.id); return n; });
    }
  };

  const remove = async () => {
    try {
      for (const p of selected) await apiClient.makeRequest(`/processing-jobs/plugins/${p.id}`, { method: 'DELETE' });
      setSelected([]); await load(true); onChanged?.(true);
    } catch (e: any) { setError(e.message); }
  };

  const shortImage = (img: string) => (img || '').split('/').slice(1).join('/') || img;

  return (
    <SpaceBetween size="m">
      {error && <Alert type="error" dismissible onDismiss={() => setError('')}>{error}</Alert>}
      <Table
        header={
          <Header
            counter={`(${plugins.length})`}
            description="Container images registered as processing jobs. Run them from a selection on the DICOM Studies or Analytics screen."
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button iconName="refresh" onClick={() => load()}>Refresh</Button>
                {canDelete && <Button disabled={!selected.length} onClick={remove}>Delete</Button>}
                {canManage && <Button variant="primary" onClick={openNew}>Register plugin</Button>}
              </SpaceBetween>
            }
          >Plugins</Header>
        }
        loading={loading}
        items={plugins}
        trackBy="id"
        selectionType={canDelete ? 'multi' : undefined}
        selectedItems={selected}
        onSelectionChange={({ detail }) => setSelected(detail.selectedItems as Plugin[])}
        columnDefinitions={[
          { id: 'name', header: 'Name', cell: p => canManage
            ? <Link onFollow={() => openEdit(p)}>{p.name}</Link> : p.name },
          { id: 'status', header: 'Status', minWidth: 140, cell: p => canManage
            ? <Toggle checked={p.enabled} disabled={pending.has(p.id)} onChange={() => toggle(p)}><span style={{ whiteSpace: 'nowrap' }}>{p.enabled ? 'Enabled' : 'Disabled'}</span></Toggle>
            : <StatusIndicator type={p.enabled ? 'success' : 'stopped'}>{p.enabled ? 'Enabled' : 'Disabled'}</StatusIndicator> },
          { id: 'granularity', header: 'Runs per', cell: p => <Badge>{p.manifest?.granularity || 'series'}</Badge> },
          { id: 'resources', header: 'Resources', cell: p => {
            const r = p.manifest?.resources || {};
            return (
              <SpaceBetween direction="horizontal" size="xxs">
                <span>{`${r.vcpu} vCPU, ${(r.memoryMiB / 1024).toFixed(r.memoryMiB % 1024 ? 1 : 0)} GiB, ${r.timeoutMinutes} min`}</span>
                {r.gpu > 0 && <Badge color="blue">{`${r.gpu} GPU`}</Badge>}
                {p.manifest?.producesDicom && <Badge color="green">DICOM out</Badge>}
              </SpaceBetween>
            );
          } },
          { id: 'params', header: 'Parameters', cell: p => (p.manifest?.parameters || []).map((x: any) => x.name).join(', ') || '-' },
          { id: 'image', header: 'Image', maxWidth: 320, cell: p => <Box fontSize="body-s" color="text-body-secondary">{shortImage(p.manifest?.image)}</Box> },
        ]}
        empty={<Box textAlign="center" color="inherit"><b>No plugins registered</b>
          <Box variant="p" color="inherit">Register a container image to add your own processing job.</Box></Box>}
      />

      <Modal
        visible={editorOpen}
        size="large"
        onDismiss={() => setEditorOpen(false)}
        header={<Header variant="h2" description="The manifest declares the image, resources and the parameters shown when the plugin is run.">
          {editing ? `Edit plugin: ${editing.name}` : 'Register plugin'}</Header>}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setEditorOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={saving} disabled={!validation?.valid} onClick={save}>
                {editing ? 'Save' : 'Register'}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {saveError && <Alert type="error">{saveError}</Alert>}
          <ColumnLayout columns={1}>
            <Textarea value={text} rows={22} spellcheck={false} onChange={({ detail }) => setText(detail.value)} />
          </ColumnLayout>
          {validation && (validation.valid
            ? <StatusIndicator type="success">Manifest is valid</StatusIndicator>
            : <Alert type="warning" header="Manifest has problems">
                <ul style={{ margin: 0, paddingLeft: 18 }}>{validation.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              </Alert>)}
          <ExpandableSection headerText="Container contract">
            <Box variant="p">
              For each step the container reads <code>s3://$PLUGIN_IO_BUCKET/$PLUGIN_RUN_PREFIX/steps/$AWS_BATCH_JOB_ARRAY_INDEX/input.json</code>,
              downloads the listed instances from their presigned URLs, writes files under <code>output/</code> and
              finally <code>result.json</code> with <code>status</code> SUCCEEDED, SKIPPED or FAILED. The image must live in an
              ECR repository named <code>&lt;prefix&gt;-plugin-*</code> in this account. A Python helper
              (<code>plugins/sdk/plugin_sdk.py</code>) handles this, and <code>plugins/builtin/dicom-to-nifti</code> is a complete example.
            </Box>
          </ExpandableSection>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
