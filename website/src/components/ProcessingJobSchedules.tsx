import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Container, Header, Table, Button, SpaceBetween, Box, Select, Multiselect,
  FormField, Input, Modal, Alert, StatusIndicator, Badge, Grid, RadioGroup, ColumnLayout,
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';
import { usePrivileges } from '../hooks/usePrivileges';

interface Schedule {
  id: string; name: string; processingJobId: string; enabled: boolean;
  periodSeconds: number; actionLevel: string;
  scope: { kind: 'DATASTORE' | 'VF'; id: string }[]; ruleId: string | null;
  jobParams: Record<string, any>;
  dataRangeMode?: string; bypassValue?: number | null; bypassUnit?: string | null;
  lastRunAt: string | null; nextRunAt: string | null; lastStatus: string | null;
  lastMatched: number | null; running: boolean;
}

const LEVELS = [
  { value: 'PATIENT', label: 'Patient' }, { value: 'STUDY', label: 'Study' },
  { value: 'SERIES', label: 'Series' }, { value: 'INSTANCE', label: 'Instance' },
];
// Common run periods; the value is seconds.
const PERIODS = [
  { value: '3600', label: 'Hourly' }, { value: '86400', label: 'Daily' },
  { value: '604800', label: 'Weekly' }, { value: '2592000', label: 'Every 30 days' },
];
const BYPASS_UNITS = [
  { value: 'minute', label: 'Minute(s)' }, { value: 'hour', label: 'Hour(s)' },
  { value: 'day', label: 'Day(s)' }, { value: 'month', label: 'Month(s)' },
];

function fmtPeriod(s: number) {
  if (s % 604800 === 0) return `${s / 604800} week(s)`;
  if (s % 86400 === 0) return `${s / 86400} day(s)`;
  if (s % 3600 === 0) return `${s / 3600} hour(s)`;
  return `${s}s`;
}
function statusType(s: string | null) {
  const v = (s || '').toUpperCase();
  if (v === 'OK') return 'success';
  if (v === 'NO_DATA') return 'stopped';
  if (v.startsWith('ERROR')) return 'error';
  return 'stopped';
}

export default function ProcessingJobSchedules() {
  const { hasManagementAccess } = usePrivileges();
  const canCreate = hasManagementAccess('processingJobs', 'canCreate');
  const canDelete = hasManagementAccess('processingJobs', 'canDelete');
  const canRun = hasManagementAccess('processingJobs', 'canRun');

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [scopeOptions, setScopeOptions] = useState<{ value: string; label: string; kind: 'DATASTORE' | 'VF'; id: string }[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create/edit modal
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [jobId, setJobId] = useState<any>(null);
  const [period, setPeriod] = useState<any>(PERIODS[2]);
  const [level, setLevel] = useState<any>(LEVELS[1]);
  const [selScope, setSelScope] = useState<any[]>([]);
  const [ruleId, setRuleId] = useState<any>(null);
  const [jobParams, setJobParams] = useState<Record<string, string>>({});
  const [vfOptionsForParams, setVfOptionsForParams] = useState<any[]>([]);
  const [dataRangeMode, setDataRangeMode] = useState<string>('SINCE_LAST_RUN');
  const [bypassValue, setBypassValue] = useState<string>('1');
  const [bypassUnit, setBypassUnit] = useState<any>(BYPASS_UNITS[2]);
  const [saving, setSaving] = useState(false);

  // Set true just before an edit modal opens so the job-change effect keeps the
  // saved params instead of overwriting them with the job's defaults once.
  const preserveParamsOnce = useRef(false);

  // The descriptor parameters of the currently-selected job template.
  const selectedJobObj = jobs.find(j => j.id === jobId?.value);
  const jobDescriptorParams: any[] = selectedJobObj?.config?.descriptor?.parameters || [];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await apiClient.makeRequest<Schedule[]>('/processing-job-schedules');
      setSchedules(resp.data || []);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load job templates + scope options (storages + VFs) once.
  useEffect(() => {
    (async () => {
      try {
        const jr = await apiClient.makeRequest<any[]>('/processing-jobs');
        setJobs((jr.data || []).filter((j: any) => !j.parentJobId));
      } catch {}
      try {
        const opts: any[] = [];
        const ds = await apiClient.getDatastores({ page: 1, pageSize: 100 } as any);
        for (const d of ((ds as any)?.data?.items || (ds as any)?.data || [])) if (d?.id) opts.push({ value: `DATASTORE:${d.id}`, label: `${d.name} (Storage)`, kind: 'DATASTORE', id: d.id });
        try {
          const vf = await apiClient.getVirtualFolders({ page: 1, pageSize: 100 } as any);
          for (const f of ((vf as any)?.data?.items || (vf as any)?.data || [])) if (f?.id) opts.push({ value: `VF:${f.id}`, label: `${f.name} (Virtual Folder)`, kind: 'VF', id: f.id });
        } catch {}
        setScopeOptions(opts);
      } catch {}
    })();
  }, []);

  // Load assignment rules for the selected VF scope (optional filter).
  useEffect(() => {
    (async () => {
      const vf = selScope.find((s: any) => s.kind === 'VF');
      if (!vf) { setRules([]); return; }
      try {
        const r = await apiClient.makeRequest<any[]>(`/virtual-folders/${vf.id}/assignment-rules`);
        setRules(r.data || []);
      } catch { setRules([]); }
    })();
  }, [selScope]);

  // Once assignment rules load, upgrade a selected rule's label from the
  // id-fallback ("Rule <id> (unavailable)") to its real name.
  useEffect(() => {
    if (!ruleId?.value || !rules.length) return;
    const match = rules.find(r => r.id === ruleId.value);
    if (match && match.name && match.name !== ruleId.label) {
      setRuleId({ value: ruleId.value, label: match.name });
    }
  }, [rules, ruleId]);

  const openCreate = () => {
    setEditId(null); setName(''); setJobId(null); setPeriod(PERIODS[2]);
    setLevel(LEVELS[1]); setSelScope([]); setRuleId(null); setError('');
    setJobParams({}); setDataRangeMode('SINCE_LAST_RUN'); setBypassValue('1'); setBypassUnit(BYPASS_UNITS[2]);
    setShowModal(true);
  };
  const openEdit = (s: Schedule) => {
    setEditId(s.id); setName(s.name);
    preserveParamsOnce.current = true;
    setJobId(jobs.find(j => j.id === s.processingJobId) ? { value: s.processingJobId, label: jobs.find(j => j.id === s.processingJobId)?.name } : null);
    setPeriod(PERIODS.find(p => Number(p.value) === s.periodSeconds) || { value: String(s.periodSeconds), label: fmtPeriod(s.periodSeconds) });
    setLevel(LEVELS.find(l => l.value === s.actionLevel) || LEVELS[1]);
    setSelScope((s.scope || []).map(sc => scopeOptions.find(o => o.kind === sc.kind && o.id === sc.id) || {
      // Saved scope entity not in the live options list (deleted or not yet
      // loaded). Show a readable label marking it deleted rather than a raw
      // kind:uuid — the id is kept as the value so the selection is preserved.
      value: `${sc.kind}:${sc.id}`,
      label: `${sc.kind === 'VF' ? 'Virtual folder' : 'Datastore'} ${sc.id} (deleted)`,
      kind: sc.kind,
      id: sc.id
    }));
    setRuleId(s.ruleId ? { value: s.ruleId, label: (rules.find(r => r.id === s.ruleId)?.name) || `Rule ${s.ruleId} (unavailable)` } : null);
    setJobParams(s.jobParams || {});
    setDataRangeMode(s.dataRangeMode || 'SINCE_LAST_RUN');
    setBypassValue(s.bypassValue != null ? String(s.bypassValue) : '1');
    setBypassUnit(BYPASS_UNITS.find(u => u.value === s.bypassUnit) || BYPASS_UNITS[2]);
    setShowModal(true);
  };

  // When the selected job changes, seed its descriptor defaults + load VF
  // options if any param needs them. A one-shot ref preserves the SAVED params
  // the first time an edit modal renders (so we don't clobber them with
  // defaults), then normal default-seeding resumes for subsequent job switches.
  useEffect(() => {
    if (!selectedJobObj) return;
    if (preserveParamsOnce.current) {
      preserveParamsOnce.current = false;
    } else {
      const defaults: Record<string, string> = {};
      for (const p of jobDescriptorParams) if (p.default != null) defaults[p.name] = String(p.default);
      setJobParams(defaults);
    }
    if (jobDescriptorParams.some((p: any) => p.type === 'virtual-folder-select') && !vfOptionsForParams.length) {
      apiClient.getVirtualFolders({ pageSize: 100 } as any).then((r: any) =>
        setVfOptionsForParams(((r?.data?.items || r?.data || [])).filter((f: any) => f.status === 'ACTIVE'))).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const save = async () => {
    setSaving(true); setError('');
    try {
      const body = {
        name: name.trim(),
        processingJobId: jobId?.value,
        periodSeconds: Number(period?.value),
        actionLevel: level?.value,
        scope: selScope.map((s: any) => ({ kind: s.kind, id: s.id })),
        ruleId: ruleId?.value || null,
        jobParams,
        dataRangeMode,
        ...(dataRangeMode === 'BYPASS_RECENT'
          ? { bypassValue: parseInt(bypassValue, 10) || 0, bypassUnit: bypassUnit?.value }
          : {}),
      };
      if (editId) await apiClient.makeRequest(`/processing-job-schedules/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiClient.makeRequest('/processing-job-schedules', { method: 'POST', body: JSON.stringify(body) });
      setShowModal(false);
      setSuccess(editId ? 'Schedule updated.' : 'Schedule created.');
      setTimeout(() => setSuccess(''), 4000);
      load();
    } catch (e: any) { setError(e.message || 'Failed to save schedule'); }
    setSaving(false);
  };

  const toggleEnabled = async (s: Schedule) => {
    try {
      await apiClient.makeRequest(`/processing-job-schedules/${s.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !s.enabled }) });
      load();
    } catch (e: any) { setError(e.message); }
  };
  const runNow = async (s: Schedule) => {
    try {
      await apiClient.makeRequest(`/processing-job-schedules/${s.id}/run-now`, { method: 'POST' });
      setSuccess(`Triggered '${s.name}' now.`); setTimeout(() => setSuccess(''), 4000);
      setTimeout(load, 2000);
    } catch (e: any) { setError(e.message); }
  };
  const remove = async (s: Schedule) => {
    try { await apiClient.makeRequest(`/processing-job-schedules/${s.id}`, { method: 'DELETE' }); load(); }
    catch (e: any) { setError(e.message); }
  };

  // Render one descriptor parameter (same three field types as ProcessingJobModal),
  // so a job with more parameters is configurable inline here.
  const renderJobParam = (param: any) => {
    const value = jobParams[param.name] || '';
    const set = (v: string) => setJobParams({ ...jobParams, [param.name]: v });
    if (param.type === 'virtual-folder-select') {
      return (
        <FormField key={param.name} label={param.label} description={param.description}>
          <Select
            selectedOption={value ? { value, label: vfOptionsForParams.find(f => f.id === value)?.name || value } : null}
            onChange={({ detail }) => set(detail.selectedOption.value || '')}
            options={vfOptionsForParams.map(f => ({ value: f.id, label: f.name }))}
            placeholder="Select a virtual folder" />
        </FormField>
      );
    }
    if (param.type === 'select') {
      return (
        <FormField key={param.name} label={param.label} description={param.description}>
          <Select
            selectedOption={value ? { value, label: value } : null}
            onChange={({ detail }) => set(detail.selectedOption.value || '')}
            options={(param.options || []).map((o: string) => ({ value: o, label: o }))}
            placeholder={`Select ${String(param.label || param.name).toLowerCase()}`} />
        </FormField>
      );
    }
    return (
      <FormField key={param.name} label={param.label} description={param.description}>
        <Input value={value} onChange={({ detail }) => set(detail.value)} />
      </FormField>
    );
  };

  const missingRequiredParam = jobDescriptorParams.some((p: any) => p.required && !jobParams[p.name]);
  const bypassOk = dataRangeMode !== 'BYPASS_RECENT' || (parseInt(bypassValue, 10) >= 0 && !!bypassUnit?.value);
  const valid = name.trim() && jobId?.value && period?.value && level?.value && selScope.length > 0
    && !missingRequiredParam && bypassOk;

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="Periodically run a processing job on data modified within the run window, scoped to storages/virtual folders and optionally an assignment rule.">
        Job Schedules
      </Header>
      {error && <Alert type="error" dismissible onDismiss={() => setError('')}>{error}</Alert>}
      {success && <Alert type="success" dismissible onDismiss={() => setSuccess('')}>{success}</Alert>}

      <Table
        header={<Header variant="h2" counter={`(${schedules.length})`}
          actions={canCreate ? <Button variant="primary" iconName="add-plus" onClick={openCreate}>Create schedule</Button> : undefined}>Schedules</Header>}
        loading={loading}
        items={schedules}
        columnDefinitions={[
          { id: 'name', header: 'Name', cell: (s: Schedule) => s.name },
          { id: 'job', header: 'Job', cell: (s: Schedule) => jobs.find(j => j.id === s.processingJobId)?.name || s.processingJobId },
          { id: 'period', header: 'Period', cell: (s: Schedule) => fmtPeriod(s.periodSeconds) },
          { id: 'level', header: 'Level', cell: (s: Schedule) => <Badge>{s.actionLevel}</Badge> },
          { id: 'scope', header: 'Scope', cell: (s: Schedule) => `${s.scope?.length || 0} source(s)${s.ruleId ? ' + rule' : ''}` },
          { id: 'enabled', header: 'Enabled', cell: (s: Schedule) => (s.enabled ? <Badge color="green">Enabled</Badge> : <Box color="text-status-inactive">Disabled</Box>) },
          { id: 'last', header: 'Last run', cell: (s: Schedule) => (
            <StatusIndicator type={statusType(s.lastStatus) as any}>
              {s.lastStatus || 'never'}{s.lastMatched != null ? ` (${s.lastMatched})` : ''}
            </StatusIndicator>) },
          { id: 'next', header: 'Next run', cell: (s: Schedule) => s.nextRunAt || '—' },
          { id: 'actions', header: 'Actions', cell: (s: Schedule) => (
            <SpaceBetween direction="horizontal" size="xs">
              {canRun && <Button variant="normal" iconName="caret-right-filled" onClick={() => runNow(s)}>Run now</Button>}
              {canCreate && <Button variant="normal" onClick={() => toggleEnabled(s)}>{s.enabled ? 'Disable' : 'Enable'}</Button>}
              {canCreate && <Button variant="normal" iconName="edit" onClick={() => openEdit(s)}>Edit</Button>}
              {canDelete && <Button variant="normal" iconName="remove" onClick={() => remove(s)}>Delete</Button>}
            </SpaceBetween>) },
        ]}
        empty={<Box textAlign="center" color="inherit" padding="l"><b>No schedules</b><Box variant="p" color="inherit">Create a schedule to run a processing job periodically.</Box></Box>}
      />

      <Modal
        visible={showModal}
        onDismiss={() => setShowModal(false)}
        header={editId ? 'Edit schedule' : 'Create schedule'}
        size="large"
        footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => setShowModal(false)}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!valid || saving} onClick={save}>{editId ? 'Save' : 'Create'}</Button>
        </SpaceBetween></Box>}
      >
        <Grid gridDefinition={[{ colspan: 6 }, { colspan: 6 }]}>
          {/* Left: schedule configuration */}
          <Container header={<Header variant="h3">Schedule</Header>}>
            <SpaceBetween size="m">
              <FormField label="Name"><Input value={name} onChange={({ detail }) => setName(detail.value)} placeholder="e.g. Weekly NIfTI conversion" /></FormField>
              <FormField label="Processing job" description="The job template to run each period.">
                <Select selectedOption={jobId} onChange={({ detail }) => setJobId(detail.selectedOption)}
                  options={jobs.map(j => ({ value: j.id, label: j.name }))} placeholder="Select a job" filteringType="auto"
                  empty="No job templates defined" />
              </FormField>
              <FormField label="Run period" description="How often the schedule fires.">
                <Select selectedOption={period} onChange={({ detail }) => setPeriod(detail.selectedOption)} options={PERIODS} />
              </FormField>
              <FormField label="Action level" description="The level the job operates on.">
                <Select selectedOption={level} onChange={({ detail }) => setLevel(detail.selectedOption)} options={LEVELS} />
              </FormField>
              <FormField label="Scope" description="One or more storages and/or virtual folders to process.">
                <Multiselect selectedOptions={selScope} onChange={({ detail }) => setSelScope(detail.selectedOptions as any)}
                  options={scopeOptions} placeholder="Select storages / virtual folders" filteringType="auto" />
              </FormField>
              {rules.length > 0 && (
                <FormField label="Assignment rule filter (optional)" description="Only process data matching this virtual folder assignment rule.">
                  <Select selectedOption={ruleId} onChange={({ detail }) => setRuleId(detail.selectedOption)}
                    options={[{ value: '', label: 'No filter' }, ...rules.map(r => ({ value: r.id, label: r.name }))]} />
                </FormField>
              )}
            </SpaceBetween>
          </Container>

          {/* Right: this job's specific parameters + data range */}
          <Container header={<Header variant="h3">Job parameters & data range</Header>}>
            <SpaceBetween size="m">
              {!jobId && <Box color="text-body-secondary">Select a processing job to configure its parameters.</Box>}
              {jobId && jobDescriptorParams.length === 0 && (
                <Box color="text-body-secondary">This job has no configurable parameters.</Box>
              )}
              {jobId && jobDescriptorParams.map(renderJobParam)}

              <FormField label="Data range" description="Which data each run processes.">
                <RadioGroup
                  value={dataRangeMode}
                  onChange={({ detail }) => setDataRangeMode(detail.value)}
                  items={[
                    { value: 'SINCE_LAST_RUN', label: 'Data modified since the last run', description: 'The default: each run processes what changed since the previous run.' },
                    { value: 'ALL_UNPROCESSED', label: 'Run processing for all non-processed data', description: 'Process all data in scope that never went through this job (the job skips work already done).' },
                    { value: 'BYPASS_RECENT', label: 'Bypass data modified in the last…', description: 'Skip data changed within a settling window; process everything older.' },
                  ]}
                />
              </FormField>
              {dataRangeMode === 'BYPASS_RECENT' && (
                <ColumnLayout columns={2}>
                  <FormField label="Amount">
                    <Input type="number" value={bypassValue} onChange={({ detail }) => setBypassValue(detail.value)} />
                  </FormField>
                  <FormField label="Unit">
                    <Select selectedOption={bypassUnit} onChange={({ detail }) => setBypassUnit(detail.selectedOption)} options={BYPASS_UNITS} />
                  </FormField>
                </ColumnLayout>
              )}
            </SpaceBetween>
          </Container>
        </Grid>
      </Modal>
    </SpaceBetween>
  );
}
