import React, { useEffect, useMemo, useState } from 'react';
import { formatTimestamp } from '../utils/dateUtils';
import {
  Table, Header, Container, StatusIndicator, Box, Button, SpaceBetween, Alert,
  Badge, ColumnLayout, SegmentedControl, TextFilter, Modal, KeyValuePairs, Link
} from '@cloudscape-design/components';
import { getSystemMonitor } from '../services/apiClient';

// One SQS queue of this deployment, as returned by GET /system-monitor.
interface QueueConsumer {
  functionName: string;
  displayName?: string;
  state: string;
  batchSize?: number;
  maximumConcurrency?: number | null;
}

// Location, client and heartbeat come back null (detailsHidden) unless the
// caller may also list locations or DICOM interfaces.
interface DimseInfo {
  role: 'inbound' | 'outbound' | 'heartbeat';
  clientId: string | null;
  locationId: string | null;
  locationName: string | null;
  serverStatus: string;
  lastHeartbeat: string | null;
  heartbeatAgeSeconds: number | null;
  detailsHidden?: boolean;
}

const HIDDEN_TEXT = 'Hidden (needs list access to Locations or Interfaces)';

interface QueueStatus {
  name: string;
  fifo: boolean;
  category: 'pipeline' | 'dlq' | 'dimse';
  description: string;
  messagesVisible: number;
  messagesInFlight: number;
  messagesDelayed: number;
  oldestMessageAgeSeconds: number | null;
  sentLastHour: number | null;
  deletedLastHour: number | null;
  peakVisible24h: number | null;
  retentionSeconds: number;
  visibilityTimeoutSeconds: number;
  createdAt: string | null;
  deadLetterQueue: string | null;
  maxReceiveCount: number | null;
  sourceQueues: string[];
  consumers: QueueConsumer[];
  dimse: DimseInfo | null;
  status: 'healthy' | 'info' | 'warning' | 'error';
  statusReason: string;
}

type CategoryFilter = 'all' | 'pipeline' | 'dlq' | 'dimse' | 'attention';

const STATUS_TYPE: Record<QueueStatus['status'], 'success' | 'info' | 'warning' | 'error'> = {
  healthy: 'success', info: 'info', warning: 'warning', error: 'error'
};
const STATUS_ORDER: Record<QueueStatus['status'], number> = { error: 0, warning: 1, info: 2, healthy: 3 };
const CATEGORY_LABEL: Record<QueueStatus['category'], string> = {
  pipeline: 'Processing', dlq: 'Dead-letter', dimse: 'DICOM service'
};

function formatAge(seconds: number | null | undefined): string {
  if (seconds == null) return '-';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

function formatCount(n: number | null | undefined): string {
  return n == null ? '-' : Math.round(n).toLocaleString();
}

function consumerText(q: QueueStatus): string {
  if (!q.consumers.length) return 'None';
  return q.consumers
    .map(c => {
      const n = c.displayName || c.functionName;
      return c.state === 'Enabled' ? n : `${n} (${c.state.toLowerCase()})`;
    })
    .join(', ');
}

// Strip the deployment prefix from a queue name for display ("qa3-audit-queue" -> "audit-queue").
function shortName(name: string, prefix: string): string {
  return prefix && name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name;
}

export const SystemMonitor: React.FC = () => {
  const [queues, setQueues] = useState<QueueStatus[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [filterText, setFilterText] = useState('');
  const [selected, setSelected] = useState<QueueStatus | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const response = await getSystemMonitor();
      setQueues(response.data.queues || []);
      setGeneratedAt(response.data.generatedAt || null);
      setUnavailable(response.data.unavailable || []);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load queue monitor data:', { errorType: err?.name });
      setError('The queue list could not be loaded. It will be retried automatically.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000); // Refresh every 30 seconds
    return () => clearInterval(interval);
  }, []);

  // Every queue name starts with the deployment prefix; find it to shorten names.
  const prefix = useMemo(() => {
    const first = queues[0]?.name || '';
    const p = first.split('-')[0];
    return p && queues.every(q => q.name.startsWith(`${p}-`)) ? p : '';
  }, [queues]);

  const counts = useMemo(() => ({
    total: queues.length,
    failed: queues.filter(q => q.category === 'dlq' && q.messagesVisible > 0).length,
    warnings: queues.filter(q => q.status === 'warning').length,
    waiting: queues.filter(q => q.category !== 'dlq').reduce((s, q) => s + q.messagesVisible + q.messagesDelayed, 0),
    inFlight: queues.reduce((s, q) => s + q.messagesInFlight, 0),
    dimse: queues.filter(q => q.category === 'dimse').length,
  }), [queues]);

  const items = useMemo(() => {
    const text = filterText.trim().toLowerCase();
    return queues.filter(q => {
      if (category === 'attention' && (q.status === 'healthy')) return false;
      if (category !== 'all' && category !== 'attention' && q.category !== category) return false;
      if (!text) return true;
      return [q.name, q.description, q.dimse?.locationName || '', consumerText(q)]
        .some(s => s.toLowerCase().includes(text));
    });
  }, [queues, category, filterText]);

  return (
    <SpaceBetween size="l">
      {error && <Alert type="error">{error}</Alert>}
      {unavailable.length > 0 && (
        <Alert type="warning">
          Some details could not be read this time ({unavailable.map(u => (
            u === 'metrics' ? 'CloudWatch metrics' : u === 'consumers' ? 'queue consumers' : 'DICOM service status'
          )).join(', ')}). The message counts are still current.
        </Alert>
      )}

      <Container header={<Header variant="h2" description={generatedAt ? `Read from SQS at ${formatTimestamp(generatedAt)}` : undefined}>Overview</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">Queues</Box>
            <Box fontSize="display-l" fontWeight="bold">{counts.total}</Box>
            <Box color="text-body-secondary">{counts.dimse} for DICOM services</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Dead-letter queues with messages</Box>
            <Box fontSize="display-l" fontWeight="bold" color={counts.failed ? 'text-status-error' : undefined}>{counts.failed}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Queues with warnings</Box>
            <Box fontSize="display-l" fontWeight="bold" color={counts.warnings ? 'text-status-warning' : undefined}>{counts.warnings}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Messages waiting / in flight</Box>
            <Box fontSize="display-l" fontWeight="bold">{counts.waiting.toLocaleString()} / {counts.inFlight.toLocaleString()}</Box>
          </div>
        </ColumnLayout>
      </Container>

      <Table
        variant="full-page"
        stickyHeader={true}
        loading={loading && queues.length === 0}
        loadingText="Reading queues"
        trackBy="name"
        items={items}
        columnDefinitions={[
          {
            id: 'name',
            header: 'Queue',
            sortingField: 'name',
            cell: (q: QueueStatus) => (
              <SpaceBetween size="xxs">
                <Link onFollow={(e: any) => { e?.preventDefault?.(); setSelected(q); }}>{shortName(q.name, prefix)}</Link>
                <Box color="text-body-secondary" fontSize="body-s">{q.description || '-'}</Box>
              </SpaceBetween>
            )
          },
          {
            id: 'category',
            header: 'Type',
            sortingField: 'category',
            cell: (q: QueueStatus) => (
              <SpaceBetween size="xxs" direction="horizontal">
                <Badge color={q.category === 'dlq' ? 'red' : q.category === 'dimse' ? 'blue' : 'grey'}>{CATEGORY_LABEL[q.category]}</Badge>
                {q.fifo && <Badge>FIFO</Badge>}
              </SpaceBetween>
            )
          },
          {
            id: 'status',
            header: 'Status',
            sortingComparator: (a: QueueStatus, b: QueueStatus) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
            cell: (q: QueueStatus) => <StatusIndicator type={STATUS_TYPE[q.status]}>{q.statusReason}</StatusIndicator>
          },
          {
            id: 'messagesVisible',
            header: 'Waiting',
            sortingField: 'messagesVisible',
            cell: (q: QueueStatus) => formatCount(q.messagesVisible + q.messagesDelayed)
          },
          {
            id: 'messagesInFlight',
            header: 'In flight',
            sortingField: 'messagesInFlight',
            cell: (q: QueueStatus) => formatCount(q.messagesInFlight)
          },
          {
            id: 'oldest',
            header: 'Oldest message',
            sortingField: 'oldestMessageAgeSeconds',
            cell: (q: QueueStatus) => (q.messagesVisible + q.messagesDelayed > 0 ? formatAge(q.oldestMessageAgeSeconds) : '-')
          },
          {
            id: 'sent',
            header: 'Received (1 h)',
            sortingField: 'sentLastHour',
            cell: (q: QueueStatus) => formatCount(q.sentLastHour)
          },
          {
            id: 'consumer',
            header: 'Consumer / location',
            cell: (q: QueueStatus) => (q.dimse
              ? `${q.dimse.detailsHidden ? 'Location hidden' : (q.dimse.locationName || q.dimse.locationId || 'Unknown location')} (${q.dimse.role})`
              : q.category === 'dlq'
                ? (q.sourceQueues.length ? `Failures from ${q.sourceQueues.map(s => shortName(s, prefix)).join(', ')}` : '-')
                : consumerText(q))
          }
        ]}
        filter={
          <SpaceBetween size="s" direction="horizontal">
            <TextFilter
              filteringText={filterText}
              filteringPlaceholder="Find a queue, location or consumer"
              countText={`${items.length} match${items.length === 1 ? '' : 'es'}`}
              onChange={({ detail }: any) => setFilterText(detail.filteringText)}
            />
            <SegmentedControl
              label="Queue type"
              selectedId={category}
              onChange={({ detail }: any) => setCategory(detail.selectedId as CategoryFilter)}
              options={[
                { id: 'all', text: 'All' },
                { id: 'attention', text: 'Needs attention' },
                { id: 'pipeline', text: 'Processing' },
                { id: 'dlq', text: 'Dead-letter' },
                { id: 'dimse', text: 'DICOM service' }
              ]}
            />
          </SpaceBetween>
        }
        empty={
          <Box textAlign="center" color="inherit">
            <b>{queues.length ? 'No queues match the filter' : 'No queues found for this deployment'}</b>
          </Box>
        }
        header={
          <Header
            variant="h1"
            counter={`(${queues.length})`}
            description="Every message queue of this deployment, including the queues each DICOM service creates when it starts. Refreshes every 30 seconds."
            actions={
              <Button
                iconName="refresh"
                onClick={() => { setIsManualRefresh(true); loadData().finally(() => setIsManualRefresh(false)); }}
                loading={isManualRefresh && loading}
              >Refresh</Button>
            }
          >
            Queues Monitor
          </Header>
        }
      />

      <Modal
        visible={!!selected}
        onDismiss={() => setSelected(null)}
        size="large"
        header={selected ? shortName(selected.name, prefix) : ''}
        footer={<Box float="right"><Button variant="primary" onClick={() => setSelected(null)}>Close</Button></Box>}
      >
        {selected && (
          <SpaceBetween size="l">
            <StatusIndicator type={STATUS_TYPE[selected.status]}>{selected.statusReason}</StatusIndicator>
            <KeyValuePairs
              columns={3}
              items={[
                { label: 'Full name', value: selected.name },
                { label: 'Type', value: `${CATEGORY_LABEL[selected.category]}${selected.fifo ? ', FIFO' : ''}` },
                { label: 'Description', value: selected.description || '-' },
                { label: 'Waiting', value: formatCount(selected.messagesVisible) },
                { label: 'Delayed', value: formatCount(selected.messagesDelayed) },
                { label: 'In flight', value: formatCount(selected.messagesInFlight) },
                { label: 'Oldest message', value: formatAge(selected.oldestMessageAgeSeconds) },
                { label: 'Received in the last hour', value: formatCount(selected.sentLastHour) },
                { label: 'Processed in the last hour', value: formatCount(selected.deletedLastHour) },
                { label: 'Highest waiting count in 24 h', value: formatCount(selected.peakVisible24h) },
                { label: 'Visibility timeout', value: formatAge(selected.visibilityTimeoutSeconds) },
                { label: 'Retention', value: formatAge(selected.retentionSeconds) },
                { label: 'Dead-letter queue', value: selected.deadLetterQueue
                    ? `${shortName(selected.deadLetterQueue, prefix)} after ${selected.maxReceiveCount} attempts` : 'None' },
                { label: 'Receives failures from', value: selected.sourceQueues.length
                    ? selected.sourceQueues.map(s => shortName(s, prefix)).join(', ') : '-' },
                { label: 'Consumers', value: selected.consumers.length
                    ? selected.consumers.map(c => `${c.functionName}: ${c.state}${c.batchSize ? `, batch ${c.batchSize}` : ''}${c.maximumConcurrency ? `, max ${c.maximumConcurrency} concurrent` : ''}`).join('; ')
                    : 'None' },
                { label: 'Created', value: selected.createdAt ? formatTimestamp(selected.createdAt) : '-' },
                ...(selected.dimse && selected.dimse.detailsHidden ? [
                  { label: 'Location', value: HIDDEN_TEXT },
                  { label: 'Service status', value: selected.dimse.serverStatus }
                ] : selected.dimse ? [
                  { label: 'Location', value: selected.dimse.locationName || selected.dimse.locationId || '-' },
                  { label: 'DICOM service client', value: selected.dimse.clientId || '-' },
                  { label: 'Service status', value: selected.dimse.serverStatus },
                  { label: 'Last heartbeat', value: selected.dimse.lastHeartbeat
                      ? `${formatTimestamp(selected.dimse.lastHeartbeat)} (${formatAge(selected.dimse.heartbeatAgeSeconds)} ago)` : '-' }
                ] : [])
              ]}
            />
          </SpaceBetween>
        )}
      </Modal>
    </SpaceBetween>
  );
};

export default SystemMonitor;
