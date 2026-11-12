import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal, Box, SpaceBetween, Button, FormField, Input, Checkbox, Alert,
  Tiles, Select, ExpandableSection
} from '@cloudscape-design/components';
import { apiClient, ImportSetup } from '../services/apiClient';

interface ImportDatastoreModalProps {
  visible: boolean;
  onDismiss: () => void;
  /** Called after a successful import so the caller can refresh its datastore list. */
  onSuccess?: () => void;
  /** Surface success/error to the host (uses the host's flashbar). */
  onNotify?: (type: 'success' | 'error' | 'warning', header: string, content?: string) => void;
}

type SourceMode = 'this-account' | 'another-account';

interface CrossAccountPending {
  datastoreId: string;
  ready: boolean;
  missing: { step: string; message: string }[];
  adminSetup: any;
  ownerSetup: any;
}

interface ImportForm {
  sourceMode: SourceMode;
  /** Selected bucket name when sourceMode === 'this-account'. */
  selectedBucket: string;
  /** Free-text bucket ARN when sourceMode === 'another-account'. */
  bucketArn: string;
  /** 12-digit owning account id when sourceMode === 'another-account'. */
  sourceAccountId: string;
  name: string;
  description: string;
  prefix: string;
  indexExisting: boolean;
}

const EMPTY_FORM: ImportForm = {
  sourceMode: 'this-account',
  selectedBucket: '',
  bucketArn: '',
  sourceAccountId: '',
  name: '',
  description: '',
  prefix: '',
  indexExisting: false
};

// arn:aws:s3:::bucket-name  (ARN preferred; a bare name is also accepted).
function isValidBucketArn(v: string): boolean {
  const t = v.trim();
  if (/^arn:aws[a-z-]*:s3:::([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])$/.test(t)) return true;
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(t) && !t.includes('..');
}

/**
 * v2 import-existing-bucket flow. Two source modes:
 *   • This account    — a searchable list of the account's own buckets
 *                        (GET /datastores/import/list-buckets), pick one.
 *   • Another account  — free-text bucket ARN, for a CROSS-ACCOUNT bucket. The
 *                        owner must apply the generated bucket policy and wire
 *                        the ingest notification themselves (documented limits).
 * An imported storage is always read-only, and the archive never changes the
 * bucket's settings: "Get setup instructions" returns the commands the bucket
 * owner runs BEFORE import (Deployment tag, event notification to the ingest
 * queue, and only when needed bucket-policy / KMS key-policy statements), with
 * the IAM permissions needed to run them. The import checks the tag and the
 * notification and refuses the bucket until both are in place. Wraps POST
 * /datastores/import + GET /datastores/import/{list-buckets,bucket-policy}.
 * Composed by DatastoreManagement (Storage menu, primary home) and ImportCenter.
 */
export const ImportDatastoreModal: React.FC<ImportDatastoreModalProps> = ({
  visible,
  onDismiss,
  onSuccess,
  onNotify
}) => {
  const [form, setForm] = useState<ImportForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [setup, setSetup] = useState<ImportSetup | null>(null);
  // Cross-account post-register state: the registered datastore id, the admin +
  // owner runbooks the API returned, and what verification found still missing.
  const [pending, setPending] = useState<CrossAccountPending | null>(null);
  const [rechecking, setRechecking] = useState(false);

  // Account bucket list (This account mode).
  const [buckets, setBuckets] = useState<{ name: string; arn: string }[]>([]);
  const [bucketsLoading, setBucketsLoading] = useState(false);
  const [bucketsError, setBucketsError] = useState<string | null>(null);

  const notify = (type: 'success' | 'error' | 'warning', header: string, content?: string) => {
    if (onNotify) onNotify(type, header, content);
  };

  const crossAccount = form.sourceMode === 'another-account';

  // The effective bucket identifier for the current source mode.
  const bucketRef = crossAccount ? form.bucketArn.trim() : form.selectedBucket;
  const bucketArnForApi = crossAccount
    ? form.bucketArn.trim()
    : (buckets.find(b => b.name === form.selectedBucket)?.arn || (form.selectedBucket ? `arn:aws:s3:::${form.selectedBucket}` : ''));

  const bucketValid = crossAccount ? isValidBucketArn(form.bucketArn) : !!form.selectedBucket;

  const loadBuckets = useCallback(async () => {
    setBucketsLoading(true);
    setBucketsError(null);
    try {
      const resp = await apiClient.listImportBuckets();
      if (resp.success && resp.data?.buckets) {
        setBuckets(resp.data.buckets);
      } else {
        setBucketsError((resp as any)?.error?.message || 'Failed to list account buckets.');
      }
    } catch (e: any) {
      setBucketsError(e?.message || 'Failed to list account buckets.');
    } finally {
      setBucketsLoading(false);
    }
  }, []);

  // Load buckets when the modal opens in / switches to This-account mode.
  useEffect(() => {
    if (visible && form.sourceMode === 'this-account' && buckets.length === 0 && !bucketsLoading) {
      loadBuckets();
    }
  }, [visible, form.sourceMode, buckets.length, bucketsLoading, loadBuckets]);

  // A change to the bucket or prefix invalidates previously fetched instructions.
  useEffect(() => { setSetup(null); }, [bucketRef, form.prefix]);

  const close = () => {
    setForm(EMPTY_FORM);
    setSetup(null);
    setPending(null);
    onDismiss();
  };

  const handleImport = async () => {
    if (!bucketValid || !form.name.trim()) {
      notify('warning', 'Missing fields', crossAccount
        ? 'A valid bucket ARN and a datastore name are required.'
        : 'Select a bucket and enter a datastore name.');
      return;
    }
    if (crossAccount && !/^\d{12}$/.test(form.sourceAccountId)) {
      notify('warning', 'Source account required', 'Enter the 12-digit AWS account id that owns the bucket.');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await apiClient.importDatastore({
        name: form.name.trim(),
        bucketArn: bucketArnForApi,
        description: form.description.trim() || undefined,
        prefix: form.prefix.trim() || undefined,
        indexExisting: form.indexExisting,
        crossAccount,
        ...(crossAccount ? { sourceAccountId: form.sourceAccountId } : {})
      } as any);
      if (resp.success) {
        if (crossAccount) {
          const d = resp.data as any;
          setPending({
            datastoreId: d?.datastore?.id, ready: !!d?.ready, missing: d?.missing || [],
            adminSetup: d?.adminSetup, ownerSetup: d?.ownerSetup
          });
          if (d?.ready) {
            notify('success', 'Cross-account bucket active', 'Both the admin and owner steps are in place; the storage is active.');
            close();
            onSuccess?.();
          } else {
            notify('warning', 'Registered — setup outstanding',
              'The bucket is registered. Apply the admin and owner steps below, then press Re-check.');
            onSuccess?.();   // refresh the list so the PENDING_SETUP row shows
          }
        } else {
          const started = (resp.data as any)?.backfill?.started;
          notify('success', 'Bucket imported',
            form.indexExisting
              ? (started ? 'Datastore registered; backfill of existing objects started.' : 'Datastore registered; backfill could not start (see status).')
              : 'Datastore registered.');
          close();
          onSuccess?.();
        }
      } else {
        notify('error', 'Import failed', (resp as any)?.error?.message || 'Could not import bucket.');
      }
    } catch (e: any) {
      notify('error', 'Import failed', e?.message || 'Could not import bucket.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRecheck = async () => {
    if (!pending?.datastoreId) return;
    setRechecking(true);
    try {
      const resp = await (apiClient as any).recheckImport({ datastoreId: pending.datastoreId, sourceAccountId: form.sourceAccountId });
      if (resp.success) {
        const d = resp.data;
        setPending(p => p && ({ ...p, ready: !!d?.ready, missing: d?.missing || [], adminSetup: d?.adminSetup, ownerSetup: d?.ownerSetup }));
        if (d?.ready) {
          notify('success', 'Cross-account bucket active', 'Verification passed; the storage is now active.');
          close();
          onSuccess?.();
        } else {
          notify('warning', 'Still waiting on setup', 'Some steps are still outstanding — see the list.');
          onSuccess?.();
        }
      } else {
        notify('error', 'Re-check failed', (resp as any)?.error?.message || 'Could not re-check.');
      }
    } catch (e: any) {
      notify('error', 'Re-check failed', e?.message || 'Could not re-check.');
    } finally {
      setRechecking(false);
    }
  };

  const handleGetSetup = async () => {
    if (!isValidBucketArn(bucketArnForApi)) {
      notify('warning', 'Select or enter a bucket', 'Choose a bucket (This account) or enter a valid bucket ARN (Another account) first.');
      return;
    }
    setPolicyLoading(true);
    try {
      const resp = await apiClient.getImportSetup(bucketArnForApi, form.prefix.trim() || undefined);
      if (resp.success && resp.data?.steps) {
        setSetup(resp.data);
      } else {
        notify('error', 'Could not get the setup instructions', (resp as any)?.error?.message || 'Failed to build the setup instructions.');
      }
    } catch (e: any) {
      notify('error', 'Could not get the setup instructions', e?.message || 'Failed to build the setup instructions.');
    } finally {
      setPolicyLoading(false);
    }
  };

  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text);
    notify('success', 'Copied', `${what} copied to clipboard.`);
  };

  const bucketOptions = buckets.map(b => ({ label: b.name, value: b.name }));

  return (
    <Modal
      visible={visible}
      onDismiss={submitting ? undefined : close}
      header="Import S3 bucket"
      size="large"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={close} disabled={submitting}>Cancel</Button>
            <Button
              variant="primary"
              loading={submitting}
              disabled={!bucketValid || !form.name.trim()}
              onClick={handleImport}
            >
              Import
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Box color="text-status-inactive">
          Associate an existing S3 bucket with this archive as a read-only storage. The archive only reads
          the bucket: it never writes to it and never changes its settings. Before importing, the bucket
          owner tags the bucket and sends its events to the archive's ingest queue, using the commands from
          <b> Get setup instructions</b> below.
        </Box>

        {/* Source mode */}
        <FormField label="Bucket source">
          <Tiles
            value={form.sourceMode}
            onChange={({ detail }) => setForm(f => ({ ...f, sourceMode: detail.value as SourceMode }))}
            items={[
              { value: 'this-account', label: 'This account', description: 'Pick a bucket from your account' },
              { value: 'another-account', label: 'Another account', description: 'Cross-account bucket by ARN' }
            ]}
          />
        </FormField>

        {/* Bucket selector — this account */}
        {!crossAccount && (
          <FormField
            label="Bucket"
            description="The bucket must carry this deployment's Deployment tag (the same tag as every resource of this deployment). Buckets already owned by this archive and already-registered buckets are hidden."
            secondaryControl={
              <Button iconName="refresh" onClick={loadBuckets} loading={bucketsLoading} disabled={submitting}>
                Refresh
              </Button>
            }
          >
            {bucketsError ? (
              <Alert type="error">{bucketsError}</Alert>
            ) : (
              <Select
                selectedOption={form.selectedBucket ? { label: form.selectedBucket, value: form.selectedBucket } : null}
                onChange={({ detail }) => setForm(f => ({ ...f, selectedBucket: detail.selectedOption?.value || '' }))}
                options={bucketOptions}
                placeholder={bucketsLoading ? 'Loading buckets…' : 'Select a bucket'}
                filteringType="auto"
                empty={bucketsLoading ? 'Loading…' : 'No importable buckets found'}
                disabled={submitting || bucketsLoading}
                statusType={bucketsLoading ? 'loading' : 'finished'}
                loadingText="Loading buckets…"
              />
            )}
          </FormField>
        )}

        {/* Bucket ARN — another account */}
        {crossAccount && (
          <>
            <FormField label="Bucket ARN" description="e.g. arn:aws:s3:::partner-account-dicom-bucket">
              <Input
                value={form.bucketArn}
                onChange={({ detail }) => setForm(f => ({ ...f, bucketArn: detail.value }))}
                placeholder="arn:aws:s3:::partner-account-dicom-bucket"
                disabled={submitting}
              />
            </FormField>
            <FormField label="Source account ID" description="The 12-digit AWS account that owns the bucket. Used to trust that account on the ingest queue and to verify setup.">
              <Input
                value={form.sourceAccountId}
                onChange={({ detail }) => setForm(f => ({ ...f, sourceAccountId: detail.value.replace(/[^0-9]/g, '').slice(0, 12) }))}
                placeholder="123456789012"
                disabled={submitting}
              />
            </FormField>
            <Alert type="info" header="Cross-account import (same region)">
              The bucket must be in this deployment's region. Two one-time manual steps make it work, both
              shown with exact commands under <b>Get setup instructions</b> after you register:
              the <b>archive admin</b> trusts the source account on the ingest queue, and the
              <b> bucket owner</b> applies the tag, event notification, read-only bucket policy (and a KMS
              grant if encrypted). The archive writes nothing; it verifies both sides before the storage
              goes active. Register now, then use <b>Re-check</b> once the steps are applied.
            </Alert>
          </>
        )}

        {/* Prefix comes before the setup: the event rule is limited to it */}
        <FormField label="Key prefix (optional)" description="Restrict the storage, the backfill and the bucket's event rule to keys under this prefix.">
          <Input
            value={form.prefix}
            onChange={({ detail }) => setForm(f => ({ ...f, prefix: detail.value }))}
            placeholder="dicom"
            disabled={submitting}
          />
        </FormField>

        {/* Read-only, always */}
        <Alert type="info" header="Imported storages are read-only">
          The archive indexes the bucket's objects and never writes to it. Upload from Computer into this
          storage is disabled.
        </Alert>

        {/* Owner setup, done BEFORE import */}
        <FormField
          label="Setup instructions"
          description="Commands the bucket owner runs before importing: tag the bucket and send its events to the archive's ingest queue. Fill in the key prefix first if you use one: the event rule is limited to it."
        >
          <Button
            iconName="key"
            loading={policyLoading}
            disabled={!isValidBucketArn(bucketArnForApi) || submitting}
            onClick={handleGetSetup}
          >
            Get setup instructions
          </Button>
        </FormField>
        {setup && (
          <Alert type="info" header={`Prepare ${setup.bucketName} for import`}>
            <SpaceBetween size="s">
              <Box variant="small">{setup.instructions}</Box>
              {setup.steps.map((step, i) => {
                const cmds = step.commands.join('\n');
                return (
                  <ExpandableSection
                    key={step.title}
                    defaultExpanded={step.required}
                    headerText={`${i + 1}. ${step.title}${step.required ? '' : ' (optional)'}`}
                  >
                    <SpaceBetween size="xs">
                      <Box variant="small">{step.why}</Box>
                      <Box variant="code" fontSize="body-s">
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 220, overflow: 'auto' }}>{cmds}</pre>
                      </Box>
                      <Button iconName="copy" onClick={() => copy(cmds, 'Commands')}>Copy commands</Button>
                    </SpaceBetween>
                  </ExpandableSection>
                );
              })}
              <ExpandableSection headerText="Permissions needed to run these commands">
                <SpaceBetween size="xs">
                  <Box variant="small">
                    The identity that runs the commands needs this IAM policy. The last two statements are
                    needed only for steps 3 and 4.
                  </Box>
                  <Box variant="code" fontSize="body-s">
                    <pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 220, overflow: 'auto' }}>
                      {JSON.stringify(setup.operatorPolicy, null, 2)}
                    </pre>
                  </Box>
                  <Button iconName="copy" onClick={() => copy(JSON.stringify(setup.operatorPolicy, null, 2), 'Policy')}>
                    Copy policy
                  </Button>
                </SpaceBetween>
              </ExpandableSection>
            </SpaceBetween>
          </Alert>
        )}

        {/* Cross-account post-register: runbooks + outstanding steps + Re-check */}
        {pending && (
          <Alert
            type={pending.ready ? 'success' : 'warning'}
            header={pending.ready ? 'Cross-account bucket is active' : 'Finish the cross-account setup, then re-check'}
          >
            <SpaceBetween size="s">
              {!pending.ready && pending.missing.length > 0 && (
                <Box>
                  <Box variant="small">Outstanding:</Box>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {pending.missing.map(m => <li key={m.step}><Box variant="small">{m.message}</Box></li>)}
                  </ul>
                </Box>
              )}
              {pending.adminSetup && (
                <ExpandableSection defaultExpanded headerText="Archive admin: trust the source account on the ingest queue">
                  <SpaceBetween size="xs">
                    <Box variant="small">{pending.adminSetup.why}</Box>
                    <Box variant="code" fontSize="body-s">
                      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 220, overflow: 'auto' }}>{(pending.adminSetup.commands || []).join('\n')}</pre>
                    </Box>
                    <Button iconName="copy" onClick={() => copy((pending.adminSetup.commands || []).join('\n'), 'Admin commands')}>Copy commands</Button>
                  </SpaceBetween>
                </ExpandableSection>
              )}
              {pending.ownerSetup && (pending.ownerSetup.steps || []).map((step: any, i: number) => {
                const optional = step.required ? '' : ' (optional)';
                return (
                <ExpandableSection key={step.title} defaultExpanded={step.required} headerText={`Bucket owner - ${i + 1}. ${step.title}${optional}`}>
                  <SpaceBetween size="xs">
                    <Box variant="small">{step.why}</Box>
                    <Box variant="code" fontSize="body-s">
                      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 220, overflow: 'auto' }}>{(step.commands || []).join('\n')}</pre>
                    </Box>
                    <Button iconName="copy" onClick={() => copy((step.commands || []).join('\n'), 'Owner commands')}>Copy commands</Button>
                  </SpaceBetween>
                </ExpandableSection>
                );
              })}
              {!pending.ready && (
                <Button iconName="refresh" loading={rechecking} onClick={handleRecheck}>Re-check</Button>
              )}
            </SpaceBetween>
          </Alert>
        )}

        {/* Common fields */}
        <FormField label="Datastore name" description="1-32 chars: letters, numbers, dots, hyphens, underscores.">
          <Input
            value={form.name}
            onChange={({ detail }) => setForm(f => ({ ...f, name: detail.value }))}
            placeholder="imported-archive"
            disabled={submitting}
          />
        </FormField>
        <FormField label="Description (optional)">
          <Input
            value={form.description}
            onChange={({ detail }) => setForm(f => ({ ...f, description: detail.value }))}
            placeholder="Legacy archive bucket"
            disabled={submitting}
          />
        </FormField>
        {(
          <Checkbox
            checked={form.indexExisting}
            onChange={({ detail }) => setForm(f => ({ ...f, indexExisting: detail.checked }))}
            disabled={submitting}
          >
            Index existing files now
            <Box variant="small" color="text-status-inactive">
              Queues every existing object through the ingest pipeline. Progress appears as an import job; objects become searchable as they index.
            </Box>
          </Checkbox>
        )}
      </SpaceBetween>
    </Modal>
  );
};

export default ImportDatastoreModal;
