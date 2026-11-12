import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Header, SpaceBetween, Box, Modal, FormField, Input, Select,
  Alert, Badge, Spinner, Container
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';

/**
 * Selection handed to a processing job.
 *
 * 'sql' sends the analytics query itself rather than its rows: the backend
 * re-runs and pages it, so a selection of thousands of series never travels
 * through the browser (same contract as "Add to Virtual Folder").
 * 'explicit' names studies and/or series picked in the DICOM Studies screen.
 */
export interface ProcessingJobTarget {
  mode: 'sql' | 'explicit';
  projectId?: string;
  sql?: string;
  entries?: Array<{
    datastoreId: string;
    studyInstanceUID?: string;
    seriesInstanceUID?: string;
  }>;
}

interface ProcessingJob {
  id: string; name: string; type: string; status: string; description: string;
  config: any; parentJobId: string | null;
}

interface Props {
  visible: boolean;
  onDismiss: () => void;
  target: ProcessingJobTarget | null;
  /** Human-readable description of what was selected, e.g. "2 studies, 5 series". */
  targetSummary?: string;
  onStarted?: (message: string) => void;
}

/**
 * Runs a processing job against a selection made elsewhere in the console.
 *
 * Shared by the Analytics query screen and the DICOM Studies screen so a new
 * selection-driven job type only has to be seeded in the database - the
 * parameter fields come from the job's own descriptor, exactly as in the
 * Processing Jobs screen.
 */
export default function ProcessingJobModal({ visible, onDismiss, target, targetSummary, onStarted }: Props) {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedJob, setSelectedJob] = useState<ProcessingJob | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [virtualFolders, setVirtualFolders] = useState<any[]>([]);
  const [datastores, setDatastores] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Plugin pipelines: stages that run after the selected plugin, each on the
  // series/studies the previous stage completed, with its outputs as input.
  const [chain, setChain] = useState<Array<{ pluginId: string; params: Record<string, string> }>>([]);
  const [error, setError] = useState('');

  const parameters = (selectedJob?.config?.descriptor?.parameters || []) as any[];

  // Defaults are applied here rather than left to the backend so the user sees
  // the value that will actually be used before starting the run.
  const defaultsFor = (job: ProcessingJob) => {
    const next: Record<string, string> = {};
    for (const p of (job.config?.descriptor?.parameters || [])) {
      if (p.default !== undefined && p.default !== null) next[p.name] = String(p.default);
    }
    return next;
  };
  const applyDefaults = (job: ProcessingJob) => { setParams(defaultsFor(job)); setChain([]); };
  const granularityOf = (job: ProcessingJob | null | undefined) => job?.config?.descriptor?.granularity || job?.config?.plugin?.manifest?.granularity || 'series';
  const chainCandidates = selectedJob?.type === 'PLUGIN'
    ? jobs.filter(j => j.type === 'PLUGIN' && j.config?.plugin?.enabled !== false && granularityOf(j) === granularityOf(selectedJob))
    : [];

  const loadJobs = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const resp = await apiClient.makeRequest<ProcessingJob[]>('/processing-jobs');
      // Only definitions that operate on a selection belong in this modal;
      // everything else is started from the Processing Jobs screen.
      const available = (resp.data || []).filter(j =>
        j.status === 'DEFINED' && !j.parentJobId && j.config?.descriptor?.acceptsTarget
      );
      setJobs(available);
      if (available.length === 1) {
        setSelectedJob(available[0]);
        applyDefaults(available[0]);
      }
      if (available.some(j => (j.config?.descriptor?.parameters || []).some((p: any) => p.type === 'datastore-select'))) {
        try {
          const dsResp = await apiClient.getDatastores({ pageSize: 100 });
          const items = (dsResp.data as any)?.items || dsResp.data || [];
          setDatastores((Array.isArray(items) ? items : []).filter((d: any) => (d.status || d.datastoreStatus) === 'ACTIVE'));
        } catch {}
      }
      if (available.some(j => (j.config?.descriptor?.parameters || []).some((p: any) => p.type === 'virtual-folder-select'))) {
        try {
          const vfResp = await apiClient.getVirtualFolders({ pageSize: 100 });
          setVirtualFolders((vfResp.data?.items || []).filter((f: any) => f.status === 'ACTIVE'));
        } catch {}
      }
    } catch (e: any) { setError(e.message || 'Failed to load processing jobs'); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    setSelectedJob(null); setParams({}); setChain([]); setError('');
    loadJobs();
  }, [visible, loadJobs]);

  const submit = async () => {
    if (!selectedJob || !target) return;
    setSubmitting(true); setError('');
    try {
      await apiClient.makeRequest(`/processing-jobs/${selectedJob.id}/execute`, {
        method: 'POST',
        body: JSON.stringify({
          params: visibleValues(parameters, params), target,
          ...(chain.length ? { chain: chain.map(c => {
            const defs = jobs.find(j => j.id === c.pluginId)?.config?.descriptor?.parameters || [];
            const p = visibleValues(defs, c.params);
            return { pluginId: c.pluginId, params: p, writeBack: p.writeBack, writeBackDatastoreId: p.writeBackDatastoreId };
          }) } : {}),
        }),
      });
      onDismiss();
      onStarted?.(`${selectedJob.name}${chain.length ? ` (pipeline of ${chain.length + 1} stages)` : ''} started. Track progress on the Processing Jobs screen.`);
    } catch (e: any) { setError(e.message || 'Failed to start the job'); }
    setSubmitting(false);
  };

  // A parameter with showWhen only applies (and is only shown and sent) when
  // another parameter has a given value, e.g. the write-back destination.
  const isShown = (param: any, values: Record<string, string>) =>
    !param.showWhen || values[param.showWhen.param] === param.showWhen.equals;
  const visibleValues = (defs: any[], values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).filter(([k]) => {
      const def = defs.find((d: any) => d.name === k);
      return !def || isShown(def, values);
    }));

  // Same field types the Processing Jobs screen renders, so one descriptor
  // works in both places, plus the datastore picker.
  const renderParam = (param: any, values: Record<string, string> = params,
    setValues: (v: Record<string, string>) => void = setParams, keyPrefix = '') => {
    if (!isShown(param, values)) return null;
    const description = param.description || undefined;

    if (param.type === 'datastore-select') {
      return (
        <FormField key={keyPrefix + param.name} label={param.label} description={description}>
          <Select
            selectedOption={values[param.name]
              ? { value: values[param.name], label: datastores.find(d => d.id === values[param.name])?.name || values[param.name] }
              : null}
            onChange={({ detail }) => setValues({ ...values, [param.name]: detail.selectedOption.value || '' })}
            options={datastores.map(d => ({ value: d.id, label: d.name }))}
            placeholder="Select a datastore"
            empty="No active datastores"
          />
        </FormField>
      );
    }

    if (param.type === 'virtual-folder-select') {
      return (
        <FormField key={keyPrefix + param.name} label={param.label} description={description}>
          <Select
            selectedOption={values[param.name]
              ? { value: values[param.name], label: virtualFolders.find(f => f.id === values[param.name])?.name || values[param.name] }
              : null}
            onChange={({ detail }) => setValues({ ...values, [param.name]: detail.selectedOption.value || '' })}
            options={virtualFolders.map(f => ({ value: f.id, label: f.name }))}
            placeholder="Select a virtual folder"
          />
        </FormField>
      );
    }
    if (param.type === 'select') {
      return (
        <FormField key={keyPrefix + param.name} label={param.label} description={description}>
          <Select
            selectedOption={values[param.name] ? { value: values[param.name], label: values[param.name] } : null}
            onChange={({ detail }) => setValues({ ...values, [param.name]: detail.selectedOption.value || '' })}
            options={(param.options || []).map((o: string) => ({ value: o, label: o }))}
            placeholder={`Select ${String(param.label || param.name).toLowerCase()}`}
          />
        </FormField>
      );
    }
    return (
      <FormField key={keyPrefix + param.name} label={param.label} description={description}>
        <Input
          value={values[param.name] || ''}
          onChange={({ detail }) => setValues({ ...values, [param.name]: detail.value })}
        />
      </FormField>
    );
  };

  // Write-back to a datastore needs one picked.
  const missingDestination = (values: Record<string, string>) => values.writeBack === 'datastore' && !values.writeBackDatastoreId;
  const missingRequired = parameters.some((p: any) => p.required && !params[p.name]) || missingDestination(params)
    || chain.some(c => missingDestination(c.params))
    || chain.some(c => !c.pluginId || (jobs.find(j => j.id === c.pluginId)?.config?.descriptor?.parameters || [])
      .some((p: any) => p.required && !c.params[p.name]));
  const updateStage = (i: number, next: { pluginId: string; params: Record<string, string> }) =>
    setChain(chain.map((c, k) => (k === i ? next : c)));

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={<Header variant="h2" description={targetSummary}>Run Processing Job</Header>}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>Cancel</Button>
            <Button
              variant="primary"
              loading={submitting}
              disabled={!selectedJob || !target || missingRequired || submitting}
              onClick={submit}
            >
              Start
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {error && <Alert type="error">{error}</Alert>}

        {loading ? (
          <Box textAlign="center" padding="l"><Spinner /> Loading jobs...</Box>
        ) : jobs.length === 0 ? (
          <Alert type="info">
            No processing jobs are available for a selection. Jobs appear here once they are deployed
            and you have permission to run them.
          </Alert>
        ) : (
          <>
            <FormField label="Processing job">
              <Select
                selectedOption={selectedJob ? { value: selectedJob.id, label: selectedJob.name } : null}
                onChange={({ detail }) => {
                  const job = jobs.find(j => j.id === detail.selectedOption.value) || null;
                  setSelectedJob(job);
                  if (job) applyDefaults(job); else setParams({});
                }}
                options={jobs.map(j => ({ value: j.id, label: j.name, description: j.description }))}
                placeholder="Select a processing job"
              />
            </FormField>

            {selectedJob && (
              <SpaceBetween size="s">
                <SpaceBetween direction="horizontal" size="xs">
                  <Badge>{selectedJob.type}</Badge>
                </SpaceBetween>
                <Box color="text-body-secondary">{selectedJob.description}</Box>
              </SpaceBetween>
            )}

            {parameters.map(p => renderParam(p))}

            {selectedJob?.type === 'PLUGIN' && (
              <SpaceBetween size="s">
                {chain.map((c, i) => {
                  const job = jobs.find(j => j.id === c.pluginId);
                  return (
                    <Container key={i} header={<Header variant="h3"
                      description="Runs on the series the previous stage completed, with that stage's outputs as input."
                      actions={<Button variant="icon" iconName="close" ariaLabel={`Remove stage ${i + 2}`}
                        onClick={() => setChain(chain.filter((_, k) => k !== i))} />}>{`Then run (stage ${i + 2})`}</Header>}>
                      <SpaceBetween size="s">
                        <Select
                          selectedOption={job ? { value: job.id, label: job.name } : null}
                          onChange={({ detail }) => {
                            const next = jobs.find(j => j.id === detail.selectedOption.value);
                            updateStage(i, { pluginId: next?.id || '', params: next ? defaultsFor(next) : {} });
                          }}
                          options={chainCandidates.map(j => ({ value: j.id, label: j.name, description: j.description }))}
                          placeholder="Select a plugin"
                        />
                        {(job?.config?.descriptor?.parameters || []).map((p: any) =>
                          renderParam(p, c.params, (v) => updateStage(i, { ...c, params: v }), `stage${i}-`))}
                      </SpaceBetween>
                    </Container>
                  );
                })}
                {chain.length < 4 && chainCandidates.length > 0 && (
                  <Button iconName="add-plus" onClick={() => setChain([...chain, { pluginId: '', params: {} }])}>
                    Add a pipeline stage
                  </Button>
                )}
              </SpaceBetween>
            )}
          </>
        )}
      </SpaceBetween>
    </Modal>
  );
}
