import React, { useState, useEffect, useCallback } from 'react';
import { formatTimestamp, parseUtcTimestamp } from '../utils/dateUtils';
import {
  Table, Button, Header, SpaceBetween, Box, Modal, FormField, Input, Select,
  Badge, StatusIndicator, Alert, ProgressBar
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';
import { usePrivileges } from '../hooks/usePrivileges';
import PluginsPanel from './PluginsPanel';

interface ProcessingJob {
  id: string; name: string; type: string; status: string; description: string;
  config: any; processedStepsCount: number; totalStepsCount: number;
  parentJobId: string | null; createdAt: string; createdBy: string;
}

interface Step {
  id: string; stepNumber: number; status: string; input: any; output: any;
  errorMessage: string; startedAt: string; completedAt: string;
}

const STATUS_MAP: Record<string, 'success' | 'error' | 'in-progress' | 'info' | 'stopped'> = {
  DEFINED: 'info', PENDING: 'in-progress', RUNNING: 'in-progress', COMPLETED: 'success',
  // PARTIAL: some steps converted, others failed - reported as a warning rather
  // than a clean success.
  PARTIAL: 'stopped', FAILED: 'error',
};

export default function ProcessingJobs() {
  const { hasManagementAccess } = usePrivileges();
  const canRun = hasManagementAccess('processingJobs', 'canRun');
  const canDelete = hasManagementAccess('processingJobs', 'canDelete');

  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<ProcessingJob[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Execute modal
  const [showExecuteModal, setShowExecuteModal] = useState(false);
  const [executeJob, setExecuteJob] = useState<ProcessingJob | null>(null);
  const [executeParams, setExecuteParams] = useState<Record<string, string>>({});
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState('');

  // Virtual folders for the select
  const [virtualFolders, setVirtualFolders] = useState<any[]>([]);

  // Detail modal
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailJob, setDetailJob] = useState<ProcessingJob | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [stepsLoading, setStepsLoading] = useState(false);
  // Plugin runs: per-step outputs with short-lived download URLs.
  const [pluginOutputs, setPluginOutputs] = useState<Record<number, any>>({});
  // Set once a user has deleted the run's files: { at, by }.
  const [outputsDeleted, setOutputsDeleted] = useState<{ at: string; by: string | null } | null>(null);
  // Both deletes are permanent for plugin runs, so each asks first.
  const [confirmDelete, setConfirmDelete] = useState<'runs' | 'files' | 'file' | null>(null);
  // The single output file waiting for confirmation: { key, name }.
  const [fileToDelete, setFileToDelete] = useState<{ key: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // silent=true refreshes in place, without the tables' loading state.
  const fetchJobs = useCallback(async (silent?: boolean) => {
    if (silent !== true) setLoading(true);
    try {
      const resp = await apiClient.makeRequest<ProcessingJob[]>('/processing-jobs');
      setJobs(resp.data || []);
    } catch (e: any) { setError(e.message); }
    if (silent !== true) setLoading(false);
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const definitions = jobs.filter(j => j.status === 'DEFINED' && !j.parentJobId);
  const executions = jobs.filter(j => j.parentJobId);

  const openExecute = async (job: ProcessingJob) => {
    // Seed the descriptor's defaults so the user sees the values that will
    // actually be used instead of empty fields.
    const defaults: Record<string, string> = {};
    for (const p of (job.config?.descriptor?.parameters || [])) {
      if (p.default !== undefined && p.default !== null) defaults[p.name] = String(p.default);
    }
    setExecuteJob(job); setExecuteParams(defaults); setExecuteError('');
    try {
      const resp = await apiClient.getVirtualFolders({ pageSize: 100 });
      setVirtualFolders((resp.data?.items || []).filter((f: any) => f.status === 'ACTIVE'));
    } catch {}
    setShowExecuteModal(true);
  };

  const submitExecute = async () => {
    if (!executeJob) return;
    setExecuting(true); setExecuteError('');
    try {
      await apiClient.makeRequest(`/processing-jobs/${executeJob.id}/execute`, {
        method: 'POST', body: JSON.stringify({ params: executeParams }),
      });
      setShowExecuteModal(false);
      setSuccess('Processing job started successfully.');
      setTimeout(() => setSuccess(''), 5000);
      fetchJobs();
    } catch (e: any) { setExecuteError(e.message); }
    setExecuting(false);
  };

  const openDetail = async (job: ProcessingJob) => {
    setDetailJob(job); setSteps([]); setPluginOutputs({}); setOutputsDeleted(null); setShowDetailModal(true); setStepsLoading(true);
    try {
      const resp = await apiClient.makeRequest<Step[]>(`/processing-jobs/${job.id}/steps`);
      setSteps(resp.data || []);
    } catch {}
    if (job.type === 'PLUGIN') {
      try {
        const out = await apiClient.makeRequest<any>(`/processing-jobs/runs/${job.id}/outputs`);
        const byStep: Record<number, any> = {};
        for (const st of (out.data?.steps || [])) byStep[st.stepNumber] = st;
        setPluginOutputs(byStep);
        setOutputsDeleted(out.data?.outputsDeleted || null);
      } catch {}
    }
    setStepsLoading(false);
  };

  const handleDelete = () => {
    if (!selectedItems.length) return;
    setDeleteError(''); setConfirmDelete('runs');
  };

  const runConfirmedDelete = async () => {
    setDeleting(true); setDeleteError('');
    try {
      if (confirmDelete === 'runs') {
        for (const j of selectedItems) await apiClient.makeRequest(`/processing-jobs/${j.id}`, { method: 'DELETE' });
        setSelectedItems([]); fetchJobs(true);
        setConfirmDelete(null);
      } else if (confirmDelete === 'files' && detailJob) {
        const r = await apiClient.makeRequest<any>(`/processing-jobs/runs/${detailJob.id}/outputs`, { method: 'DELETE' });
        setPluginOutputs(prev => Object.fromEntries(Object.entries(prev).map(([k, v]: [string, any]) => [k, { ...v, files: [] }])));
        setOutputsDeleted({ at: new Date().toISOString(), by: null });
        setSuccess(`Deleted ${r.data?.filesDeleted ?? 0} file(s) of ${detailJob.name}.`);
        setTimeout(() => setSuccess(''), 5000);
        setConfirmDelete(null);
      } else if (confirmDelete === 'file' && detailJob && fileToDelete) {
        await apiClient.makeRequest<any>(`/processing-jobs/runs/${detailJob.id}/outputs?key=${encodeURIComponent(fileToDelete.key)}`, { method: 'DELETE' });
        const gone = fileToDelete.key;
        setPluginOutputs(prev => Object.fromEntries(Object.entries(prev).map(([k, v]: [string, any]) =>
          [k, { ...v, files: (v.files || []).filter((f: any) => f.key !== gone) }])));
        setSuccess(`Deleted ${fileToDelete.name}.`);
        setTimeout(() => setSuccess(''), 5000);
        setFileToDelete(null); setConfirmDelete(null);
      }
    } catch (e: any) { setDeleteError(e.message); }
    setDeleting(false);
  };

  const selectedPluginRuns = selectedItems.filter(j => j.type === 'PLUGIN').length;
  const detailRunning = !!detailJob && ['PENDING', 'RUNNING'].includes(detailJob.status);

  const renderParamField = (param: any) => {
    if (param.type === 'virtual-folder-select') {
      return (
        <FormField key={param.name} label={param.label}>
          <Select
            selectedOption={executeParams[param.name] ? { value: executeParams[param.name], label: virtualFolders.find(f => f.id === executeParams[param.name])?.name || executeParams[param.name] } : null}
            onChange={({ detail }) => setExecuteParams({ ...executeParams, [param.name]: detail.selectedOption.value || '' })}
            options={virtualFolders.map(f => ({ value: f.id, label: f.name }))}
            placeholder="Select a virtual folder"
          />
        </FormField>
      );
    }
    if (param.type === 'select') {
      return (
        <FormField key={param.name} label={param.label}>
          <Select
            selectedOption={executeParams[param.name] ? { value: executeParams[param.name], label: executeParams[param.name] } : null}
            onChange={({ detail }) => setExecuteParams({ ...executeParams, [param.name]: detail.selectedOption.value || '' })}
            options={(param.options || []).map((o: string) => ({ value: o, label: o }))}
            placeholder={`Select ${param.label.toLowerCase()}`}
          />
        </FormField>
      );
    }
    return (
      <FormField key={param.name} label={param.label}>
        <Input value={executeParams[param.name] || ''} onChange={({ detail }) => setExecuteParams({ ...executeParams, [param.name]: detail.value })} />
      </FormField>
    );
  };

  const formatDate = (d: string) => formatTimestamp(d);

  // Plugin step output: summary text plus each file; images render inline.
  const renderPluginOutput = (s: Step) => {
    const o = pluginOutputs[s.stepNumber];
    const files = o?.files || [];
    const summary = o?.summary || s.output?.summary;
    const wb = o?.writeBack || s.output?.writeBack;
    if (!files.length && !summary) return '-';
    return (
      <SpaceBetween size="xxs">
        {summary && <Box fontSize="body-s">{summary}</Box>}
        {wb && (
          <Box fontSize="body-s">
            <StatusIndicator type={wb.rejected?.length ? 'warning' : 'success'}>
              {`Written back to the archive: ${wb.stored} DICOM file(s)`}{wb.rejected?.length ? `, ${wb.rejected.length} rejected` : ''}
            </StatusIndicator>
            {(wb.rejected || []).slice(0, 3).map((r: any) => (
              <Box key={r.key} fontSize="body-s" color="text-status-warning">{`${r.key.split('/').pop()}: ${r.reason}`}</Box>
            ))}
          </Box>
        )}
        <SpaceBetween direction="horizontal" size="xs">
          {files.map((f: any) => {
            const name = f.label || f.key.split('/').pop();
            const link = (f.contentType || '').startsWith('image/')
              ? <a href={f.url} target="_blank" rel="noreferrer" title={f.label || f.key}>
                  <img src={f.url} alt={f.label || f.key} style={{ maxWidth: 120, maxHeight: 120, borderRadius: 4, display: 'block' }} />
                </a>
              : <a href={f.url} target="_blank" rel="noreferrer">{name}</a>;
            return (
              <span key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                {link}
                {canDelete && !detailRunning && (
                  <Button variant="inline-icon" iconName="remove" ariaLabel={`Delete ${name}`}
                    onClick={() => { setDeleteError(''); setFileToDelete({ key: f.key, name }); setConfirmDelete('file'); }} />
                )}
              </span>
            );
          })}
        </SpaceBetween>
      </SpaceBetween>
    );
  };

  return (
    <SpaceBetween size="l">
      {error && <Alert type="error" dismissible onDismiss={() => setError('')}>{error}</Alert>}
      {success && <Alert type="success" dismissible onDismiss={() => setSuccess('')}>{success}</Alert>}

      <Header variant="h1">Processing Jobs</Header>

      <Table
        header={
          <Header counter={`(${definitions.length})`} actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" onClick={() => fetchJobs()}>Refresh</Button>
            </SpaceBetween>
          }>Available Jobs</Header>
        }
        loading={loading}
        items={definitions}
        columnDefinitions={[
          { id: 'name', header: 'Name', cell: j => j.name },
          { id: 'description', header: 'Description', cell: j => j.description || '-' },
          { id: 'type', header: 'Type', cell: j => <Badge>{j.type}</Badge> },
          // A job that runs on a selection has nowhere to get one from here, and
          // the API rejects an execute without a target - so it is started from
          // the Analytics or DICOM Studies screen instead.
          { id: 'actions', header: '', cell: j => !canRun ? null
            : j.type === 'PLUGIN' && j.config?.plugin?.enabled === false
              ? <StatusIndicator type="stopped">Disabled</StatusIndicator>
            : j.config?.descriptor?.acceptsTarget
              ? <Box color="text-body-secondary" fontSize="body-s">Run from a selection</Box>
              : <Button onClick={() => openExecute(j)}>Run</Button> },
        ]}
        empty={<Box textAlign="center"><b>No processing jobs available</b></Box>}
      />

      <PluginsPanel onChanged={fetchJobs} />

      <Table
        header={
          <Header counter={`(${executions.length})`} actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" onClick={() => fetchJobs()}>Refresh</Button>
              {canDelete && <Button disabled={!selectedItems.length} onClick={handleDelete}>Delete</Button>}
            </SpaceBetween>
          }>Job Executions</Header>
        }
        loading={loading}
        items={executions}
        selectionType="multi"
        selectedItems={selectedItems}
        trackBy="id"
        onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems as ProcessingJob[])}
        columnDefinitions={[
          { id: 'name', header: 'Name', cell: j => <Button variant="link" onClick={() => openDetail(j)}>{j.name}</Button> },
          { id: 'status', header: 'Status', cell: j => <StatusIndicator type={STATUS_MAP[j.status] || 'info'}>{j.status}</StatusIndicator> },
          { id: 'progress', header: 'Progress', cell: j => j.totalStepsCount > 0
            ? <ProgressBar value={(j.processedStepsCount / j.totalStepsCount) * 100} additionalInfo={`${j.processedStepsCount} / ${j.totalStepsCount}`} />
            : '-'
          },
          { id: 'created', header: 'Created', cell: j => formatDate(j.createdAt) },
          { id: 'createdBy', header: 'Created By', cell: j => j.createdBy || '-' },
        ]}
        empty={<Box textAlign="center"><b>No job executions</b></Box>}
      />

      {/* Execute Modal */}
      <Modal
        visible={showExecuteModal}
        onDismiss={() => setShowExecuteModal(false)}
        header={<Header variant="h2">Run: {executeJob?.name}</Header>}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowExecuteModal(false)}>Cancel</Button>
              <Button variant="primary" loading={executing} onClick={submitExecute}>Start</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="l">
          {executeError && <Alert type="error">{executeError}</Alert>}
          <Box>{executeJob?.description}</Box>
          {(executeJob?.config?.descriptor?.parameters || []).map(renderParamField)}
        </SpaceBetween>
      </Modal>

      {/* Detail Modal */}
      <Modal
        visible={showDetailModal}
        onDismiss={() => setShowDetailModal(false)}
        size="large"
        header={<Header variant="h2">{detailJob?.name}</Header>}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              {canDelete && detailJob?.type === 'PLUGIN' && !outputsDeleted && !stepsLoading && (
                <Button disabled={detailRunning} disabledReason="The run is still in progress"
                  onClick={() => { setDeleteError(''); setConfirmDelete('files'); }}>Delete files</Button>
              )}
              <Button variant="link" onClick={() => setShowDetailModal(false)}>Close</Button>
            </SpaceBetween>
          </Box>
        }
      >
        {detailJob && (
          <SpaceBetween size="l">
            {detailJob.type === 'PLUGIN' && outputsDeleted && (
              <Alert type="info">
                {`The output files of this run were deleted on ${formatDate(outputsDeleted.at)}${outputsDeleted.by ? ` by ${outputsDeleted.by}` : ''}. Anything written back to a storage is not affected.`}
              </Alert>
            )}
            <SpaceBetween direction="horizontal" size="l">
              <div><strong>Status:</strong> <StatusIndicator type={STATUS_MAP[detailJob.status] || 'info'}>{detailJob.status}</StatusIndicator></div>
              <div><strong>Created:</strong> {formatDate(detailJob.createdAt)}</div>
              {detailJob.config?.pipeline && (
                <div><strong>Pipeline:</strong> {`stage ${detailJob.config.pipeline.stage} of ${detailJob.config.pipeline.totalStages}`}
                  {(detailJob.config.pipeline.next || []).length > 0 && ` (next: ${detailJob.config.pipeline.next.map((n: any) => n.name).join(' → ')})`}</div>
              )}
              {detailJob.config?.writeBack === 'source' && <div><strong>Write-back:</strong> source datastore</div>}
              {detailJob.config?.writeBack === 'datastore' && (
                <div><strong>Write-back:</strong> {detailJob.config.writeBackDatastoreName || detailJob.config.writeBackDatastoreId}</div>
              )}
            </SpaceBetween>
            {detailJob.config?.pipeline?.error && <Alert type="warning">{detailJob.config.pipeline.error}</Alert>}
            {detailJob.totalStepsCount > 0 && (
              <ProgressBar value={(detailJob.processedStepsCount / detailJob.totalStepsCount) * 100}
                additionalInfo={`${detailJob.processedStepsCount} / ${detailJob.totalStepsCount} steps completed`} />
            )}
            <Table
              header={<Header variant="h3">Steps</Header>}
              wrapLines
              loading={stepsLoading}
              items={steps}
              columnDefinitions={[
                { id: 'step', header: '#', cell: s => s.stepNumber },
                { id: 'status', header: 'Status', cell: s => <StatusIndicator type={STATUS_MAP[s.status] || 'info'}>{s.status}</StatusIndicator> },
                // Step shapes differ by job type: the export job works on
                // studies, the NIfTI job on series.
                { id: 'input', header: 'Input', cell: s => s.input?.imagesetId || s.input?.seriesInstanceUid
                  || (s.input?.seriesInstanceUids || []).join(', ') || s.input?.studyInstanceUid || '-' },
                { id: 'output', header: 'Output', cell: s => detailJob?.type === 'PLUGIN'
                  ? renderPluginOutput(s)
                  : s.output?.uuid
                  ? `${s.output.uuid}.zip`
                  : (s.output?.outputKeys || []).length
                    ? s.output.outputKeys.map((k: string) => k.split('/').pop()).join(', ')
                    : '-' },
                { id: 'error', header: 'Error', cell: s => s.errorMessage || '-' },
                { id: 'duration', header: 'Duration', cell: s => {
                  if (!s.startedAt || !s.completedAt) return '-';
                  const ms = parseUtcTimestamp(s.completedAt).getTime() - parseUtcTimestamp(s.startedAt).getTime();
                  return `${(ms / 1000).toFixed(1)}s`;
                }},
              ]}
              empty={<Box textAlign="center">No steps</Box>}
            />
          </SpaceBetween>
        )}
      </Modal>

      {/* Delete confirmation (runs or a run's files) */}
      <Modal
        visible={confirmDelete !== null}
        onDismiss={() => !deleting && setConfirmDelete(null)}
        header={<Header variant="h2">{confirmDelete === 'files' ? 'Delete output files'
          : confirmDelete === 'file' ? 'Delete output file' : `Delete ${selectedItems.length} job execution(s)`}</Header>}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" disabled={deleting} onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="primary" loading={deleting} onClick={runConfirmedDelete}>Delete</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          {deleteError && <Alert type="error">{deleteError}</Alert>}
          {confirmDelete === 'file'
            ? <Box>{`"${fileToDelete?.name}" will be permanently deleted. The run's other files are kept.`}</Box>
            : confirmDelete === 'files'
            ? <Box>{`All output files of "${detailJob?.name}" will be permanently deleted. The run and its step history stay listed. DICOM written back to a storage is not affected.`}</Box>
            : <Box>{selectedPluginRuns
                ? `The selected runs are removed from the list, and the output files of ${selectedPluginRuns} plugin run(s) are permanently deleted. DICOM written back to a storage is not affected.`
                : 'The selected runs are removed from the list.'}</Box>}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
