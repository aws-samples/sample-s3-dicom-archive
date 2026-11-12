import React, { useState, useEffect, useCallback } from 'react';
import {
  Container,
  Header,
  ColumnLayout,
  Box,
  SpaceBetween,
  Button,
  StatusIndicator,
  PieChart,
  LineChart,
  Alert,
  Spinner,
  Select,
  SelectProps,
  DateRangePicker,
  DateRangePickerProps
} from '@cloudscape-design/components';
import { useAuth } from '../contexts/AuthContext';
import { apiClient } from '../services/apiClient';

type GrowthPoint = { datastoreId: string; datastoreName: string; x: string; y: number };

// Build a continuous per-datastore series spanning [start, end] so the Storage
// Growth chart renders the full selected period even when a datastore is younger
// than it (or has sparse snapshots). The value at the window start is the last
// snapshot at/before start (a pre-window "baseline" returned by the API), or 0 if
// the datastore did not exist yet; values carry forward to the end of the window.
function virtualizeStorageGrowth(points: GrowthPoint[], start: Date, end: Date): GrowthPoint[] {
  const startT = start.getTime();
  const endT = end.getTime();

  const byDatastore = new Map<string, { name: string; pts: { t: number; y: number }[] }>();
  points.forEach(p => {
    if (!byDatastore.has(p.datastoreId)) {
      byDatastore.set(p.datastoreId, { name: p.datastoreName, pts: [] });
    }
    const t = new Date(p.x).getTime();
    if (!isNaN(t)) byDatastore.get(p.datastoreId)!.pts.push({ t, y: p.y });
  });

  const out: GrowthPoint[] = [];
  byDatastore.forEach(({ name, pts }, datastoreId) => {
    pts.sort((a, b) => a.t - b.t);

    // Value at the window start: last known snapshot at/before start, else 0.
    let startValue = 0;
    for (const p of pts) {
      if (p.t <= startT) startValue = p.y; else break;
    }

    const series: { t: number; y: number }[] = [{ t: startT, y: startValue }];
    let lastY = startValue;
    pts.forEach(p => {
      if (p.t > startT && p.t <= endT) {
        series.push({ t: p.t, y: p.y });
        lastY = p.y;
      }
    });
    // Extend the line to the end of the window (storage persists since last snapshot).
    if (series[series.length - 1].t < endT) series.push({ t: endT, y: lastY });

    series.forEach(s => out.push({
      datastoreId,
      datastoreName: name,
      x: new Date(s.t).toISOString(),
      y: s.y,
    }));
  });

  return out;
}

const Dashboard: React.FC = () => {
  const { user } = useAuth();
  const [dashboardStats, setDashboardStats] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [recentActivity, setRecentActivity] = useState<any[]>([]);
  const [modalityData, setModalityData] = useState<any[]>([]);
  const [storageGrowthData, setStorageGrowthData] = useState<any[]>([]);
  const [growthWindow, setGrowthWindow] = useState<{ start: Date; end: Date } | null>(null);
  const [storageChangesData, setStorageChangesData] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [datastoreUtilization, setDatastoreUtilization] = useState<any[]>([]);
  const [datastores, setDatastores] = useState<any[]>([]);
  const [selectedDatastore, setSelectedDatastore] = useState<SelectProps.Option>({ 
    label: 'All Datastores', 
    value: 'all' 
  });
  const [growthDateRange, setGrowthDateRange] = useState<DateRangePickerProps.Value>({
    type: 'relative',
    amount: 7,
    unit: 'day'
  });
  const [changesDateRange, setChangesDateRange] = useState<DateRangePickerProps.Value>({
    type: 'relative',
    amount: 7,
    unit: 'day'
  });
  const [loading, setLoading] = useState(true);
  const [modalityLoading, setModalityLoading] = useState(false);
  const [storageGrowthLoading, setStorageGrowthLoading] = useState(false);
  const [storageChangesLoading, setStorageChangesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDashboardData();
  }, []);

  // Reset datastore selection if the selected datastore is no longer available (e.g., deleted)
  useEffect(() => {
    if (selectedDatastore.value !== 'all' && datastores.length > 0) {
      const selectedDatastoreExists = datastores.some(ds => 
        ds.id === selectedDatastore.value && ds.status === 'active'
      );
      
      if (!selectedDatastoreExists) {
        console.log('Selected datastore no longer available, resetting to "All Datastores"');
        setSelectedDatastore({ label: 'All Datastores', value: 'all' });
      }
    }
  }, [datastores, selectedDatastore]);

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Load dashboard statistics - this now returns per-datastore data
      const statsResponse = await apiClient.getDashboardStats();

      if (statsResponse.success) {
        const datastoreStats = statsResponse.data;
        setDashboardStats(datastoreStats);
        
        // Calculate utilization from stats data
        const totalStorage = datastoreStats.reduce((sum: number, ds: any) => sum + (ds.totalSizeBytes || 0), 0);
        const utilization = datastoreStats
          .filter((ds: any) => ds.status === 'ACTIVE')
          .map((ds: any) => ({
            name: ds.datastoreName,
            id: ds.datastoreId,
            series: ds.seriesCount || 0,
            totalBytes: ds.totalSizeBytes || 0,
            used: totalStorage > 0 ? Math.round((ds.totalSizeBytes || 0) * 100 / totalStorage) : 0
          }))
          .sort((a: any, b: any) => b.used - a.used);
        setDatastoreUtilization(utilization);
        
        // Set datastores for dropdown
        setDatastores(datastoreStats.map((ds: any) => ({
          id: ds.datastoreId,
          name: ds.datastoreName,
          status: ds.status.toLowerCase()
        })));
      } else {
        console.error('Failed to load dashboard stats:', statsResponse.message);
      }

      // Set mock recent activity for now
      setRecentActivity([
        {
          id: '1',
          type: 'Datastore Created',
          description: 'New datastore "Storage 3" created successfully',
          timestamp: new Date(Date.now() - 1000 * 60 * 30).toLocaleString(),
          status: 'success'
        },
        {
          id: '2',
          type: 'Study Imported',
          description: 'CT scan imported to Storage 1',
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2).toLocaleString(),
          status: 'success'
        },
        {
          id: '3',
          type: 'Statistics Updated',
          description: 'Datastore statistics refreshed',
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 4).toLocaleString(),
          status: 'info'
        }
      ]);

    } catch (err) {
      setError('Failed to load dashboard data');
      console.error('Error loading dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  const refreshAll = async () => {
    await loadDashboardData();
    await loadModalityData();
    setGrowthDateRange({...growthDateRange});
    setChangesDateRange({...changesDateRange});
  };

  const loadModalityData = useCallback(async () => {
    try {
      setModalityLoading(true);
      const datastoreId = selectedDatastore.value === 'all' ? undefined : selectedDatastore.value as string;
      
      console.log('Loading modality data for datastore:', datastoreId || 'all datastores');
      
      const modalityResponse = await apiClient.getModalityData(datastoreId);

      if (modalityResponse.success) {
        console.log('Modality data loaded successfully:', modalityResponse.data);
        
        // Aggregate modality counts from all datastores
        const modalityCounts: { [key: string]: number } = {};
        
        modalityResponse.data.forEach((ds: any) => {
          const series = ds.modalityBreakdown?.series || {};
          Object.entries(series).forEach(([modality, count]) => {
            modalityCounts[modality] = (modalityCounts[modality] || 0) + (count as number);
          });
        });
        
        const chartData = Object.entries(modalityCounts).map(([modality, count]) => ({
          title: modality,
          value: count
        }));
        
        setModalityData(chartData);
      } else {
        console.error('Failed to load modality data:', modalityResponse.message);
        setModalityData([]); // Clear data on failure
      }
    } catch (err) {
      console.error('Error loading modality data:', err);
      setModalityData([]); // Clear data on error
    } finally {
      setModalityLoading(false);
    }
  }, [selectedDatastore]);

  // Load modality data when selectedDatastore changes
  useEffect(() => {
    loadModalityData();
  }, [loadModalityData]);

  // Helper to split date range into monthly chunks
  const getMonthlyChunks = (start: Date, end: Date) => {
    const chunks = [];
    let current = new Date(start);
    
    while (current < end) {
      const chunkStart = new Date(current);
      const chunkEnd = new Date(current);
      chunkEnd.setMonth(chunkEnd.getMonth() + 1);
      
      if (chunkEnd > end) {
        chunks.push({ start: chunkStart, end: new Date(end) });
        break;
      }
      
      chunks.push({ start: chunkStart, end: chunkEnd });
      current = chunkEnd;
    }
    
    return chunks;
  };

  // Load storage growth with date range filter
  useEffect(() => {
    const loadStorageGrowth = async () => {
      try {
        setStorageGrowthLoading(true);
        
        let start: Date, end: Date;
        
        if (growthDateRange?.type === 'absolute') {
          start = new Date(growthDateRange.startDate);
          end = new Date(growthDateRange.endDate);
        } else if (growthDateRange?.type === 'relative') {
          end = new Date();
          start = new Date();
          const amount = growthDateRange.amount || 7;
          const unit = growthDateRange.unit || 'day';
          
          if (unit === 'day') {
            start.setDate(start.getDate() - amount);
          } else if (unit === 'month') {
            start.setMonth(start.getMonth() - amount);
          } else if (unit === 'year') {
            start.setFullYear(start.getFullYear() - amount);
          }
        } else {
          end = new Date();
          start = new Date();
          start.setDate(start.getDate() - 7);
        }
        
        const chunks = getMonthlyChunks(start, end);
        const allData: any[] = [];
        
        for (const chunk of chunks) {
          const response = await apiClient.getStorageGrowthData({
            startDate: chunk.start.toISOString().slice(0, 19).replace('T', ' '),
            endDate: chunk.end.toISOString().slice(0, 19).replace('T', ' ')
          });
          
          if (response.success) {
            allData.push(...response.data);
          }
        }
        
        const formatted = allData.map((item: any) => ({
          datastoreId: item.datastoreId,
          datastoreName: item.datastoreName,
          x: item.timestamp,
          y: item.sizeGB
        }));
        setGrowthWindow({ start, end });
        setStorageGrowthData(virtualizeStorageGrowth(formatted, start, end));
      } catch (err) {
        setStorageGrowthData([]);
      } finally {
        setStorageGrowthLoading(false);
      }
    };
    
    loadStorageGrowth();
  }, [growthDateRange]);

  // Load storage changes (deltas)
  useEffect(() => {
    const loadStorageChanges = async () => {
      try {
        setStorageChangesLoading(true);
        
        let start: Date, end: Date;
        
        if (changesDateRange?.type === 'absolute') {
          start = new Date(changesDateRange.startDate);
          end = new Date(changesDateRange.endDate);
        } else if (changesDateRange?.type === 'relative') {
          end = new Date();
          start = new Date();
          const amount = changesDateRange.amount || 7;
          const unit = changesDateRange.unit || 'day';
          
          if (unit === 'day') {
            start.setDate(start.getDate() - amount);
          } else if (unit === 'month') {
            start.setMonth(start.getMonth() - amount);
          } else if (unit === 'year') {
            start.setFullYear(start.getFullYear() - amount);
          }
        } else {
          end = new Date();
          start = new Date();
          start.setDate(start.getDate() - 7);
        }
        
        const chunks = getMonthlyChunks(start, end);
        const allData: any[] = [];
        
        for (const chunk of chunks) {
          const response = await apiClient.getStorageGrowthData({
            startDate: chunk.start.toISOString().slice(0, 19).replace('T', ' '),
            endDate: chunk.end.toISOString().slice(0, 19).replace('T', ' ')
          });
          
          if (response.success) {
            allData.push(...response.data);
          }
        }
        
        const dataByDatastore = new Map();
        
        allData.forEach((item: any) => {
          if (!dataByDatastore.has(item.datastoreId)) {
            dataByDatastore.set(item.datastoreId, []);
          }
          dataByDatastore.get(item.datastoreId).push(item);
        });
        
        const deltas: any[] = [];
        
        dataByDatastore.forEach((items, datastoreId) => {
          items.sort((a: any, b: any) => a.timestamp.localeCompare(b.timestamp));
          
          for (let i = 1; i < items.length; i++) {
            const delta = items[i].sizeGB - items[i - 1].sizeGB;
            deltas.push({
              datastoreId: items[i].datastoreId,
              datastoreName: items[i].datastoreName,
              x: items[i].timestamp,
              y: delta
            });
          }
        });
        
        setStorageChangesData(deltas);
      } catch (err) {
        setStorageChangesData([]);
      } finally {
        setStorageChangesLoading(false);
      }
    };
    
    loadStorageChanges();
  }, [changesDateRange]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const datastoreOptions: SelectProps.Option[] = [
    { label: 'All Datastores', value: 'all' },
    ...datastores
      .filter(ds => ds.status?.toLowerCase() === 'active')
      .map(ds => ({ 
        label: ds.name, 
        value: ds.id 
      }))
  ];

  if (loading) {
    return (
      <Container>
        <SpaceBetween size="l">
          <Header variant="h1">Dashboard</Header>
          <Box textAlign="center">
            <Spinner size="large" />
            <Box variant="p" margin={{ top: 's' }}>
              Loading dashboard data...
            </Box>
          </Box>
        </SpaceBetween>
      </Container>
    );
  }

  return (
    <SpaceBetween size="l">
      {error && (
        <Alert
          type="error"
          dismissible
          onDismiss={() => setError(null)}
          action={
            <Button onClick={loadDashboardData}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      {/* Welcome message */}
      <Container>
        <Header 
          variant="h1"
          actions={
            <Button 
              iconName="refresh" 
              onClick={refreshAll}
              loading={loading}
            >
              Refresh All
            </Button>
          }
        >
          Welcome, {user?.username || 'User'}
        </Header>
        <Box variant="p">
          This dashboard provides an overview of your DICOM Archive system with real-time statistics.
        </Box>
      </Container>

      {/* Key System Metrics */}
      <Container header={<Header variant="h2">System Overview</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">Total Datastores</Box>
            <Box variant="h1">
              {dashboardStats.length}
            </Box>
            <Box variant="small">
              {dashboardStats.filter(ds => ds.status === 'ACTIVE').length} active
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Total Studies</Box>
            <Box variant="h1">
              {dashboardStats.reduce((sum, ds) => sum + (ds.studyCount || 0), 0).toLocaleString()}
            </Box>
            <Box variant="small">
              {dashboardStats.reduce((sum, ds) => sum + (ds.seriesCount || 0), 0).toLocaleString()} series
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Total Storage</Box>
            <Box variant="h1">
              {formatBytes(dashboardStats.reduce((sum, ds) => sum + (ds.totalSizeBytes || 0), 0))}
            </Box>
            <Box variant="small">
              {dashboardStats.reduce((sum, ds) => sum + (ds.instanceCount || 0), 0).toLocaleString()} instances
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">System Health</Box>
            <Box variant="h1">
              <StatusIndicator type="success">Healthy</StatusIndicator>
            </Box>
            <Box variant="small">
              All systems operational
            </Box>
          </div>
        </ColumnLayout>
      </Container>

      {/* Analytics and Distribution */}
      <ColumnLayout columns={2}>
        <Container 
          header={
            <Header 
              variant="h2"
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Select
                    selectedOption={selectedDatastore}
                    onChange={({ detail }) => setSelectedDatastore(detail.selectedOption)}
                    options={datastoreOptions}
                    placeholder="Select datastore"
                    disabled={modalityLoading}
                  />
                  <Button 
                    iconName="refresh" 
                    onClick={loadModalityData}
                    loading={modalityLoading}
                    ariaLabel="Refresh modality distribution"
                  />
                </SpaceBetween>
              }
            >
              Series Distribution by Modality
              {selectedDatastore.value !== 'all' && (
                <Box variant="small" color="text-status-info">
                  Showing data for: {selectedDatastore.label}
                </Box>
              )}
            </Header>
          }
        >
          {modalityLoading ? (
            <Box textAlign="center" padding="l">
              <Spinner />
              <Box variant="p" margin={{ top: 's' }}>
                Loading modality data for {selectedDatastore.value === 'all' ? 'all datastores' : selectedDatastore.label}...
              </Box>
            </Box>
          ) : modalityData.length > 0 ? (
            <PieChart
              data={modalityData}
              detailPopoverContent={(datum, sum) => [
                { key: 'Series Count', value: datum.value.toLocaleString() },
                { key: 'Percentage', value: `${((datum.value / sum) * 100).toFixed(1)}%` },
                ...(selectedDatastore.value !== 'all' ? [{ key: 'Datastore', value: selectedDatastore.label }] : [])
              ]}
              segmentDescription={(datum, sum) => 
                `${datum.title}: ${datum.value.toLocaleString()} series (${((datum.value / sum) * 100).toFixed(1)}%)`
              }
              size="medium"
              hideFilter
              hideLegend={false}
              hideTitles
              hideDescriptions
              variant="donut"
              innerMetricDescription="Total Series"
              innerMetricValue={modalityData.reduce((sum, item) => sum + item.value, 0).toLocaleString()}
            />
          ) : (
            <Box textAlign="center" padding="l">
              <Box variant="strong">No modality data available</Box>
              <Box variant="p">
                {selectedDatastore.value === 'all' 
                  ? 'Import some DICOM studies to see modality distribution across all datastores'
                  : `No DICOM studies found in "${selectedDatastore.label}". Import studies to see modality distribution.`
                }
              </Box>
              {selectedDatastore.value !== 'all' && (
                <Box variant="small" color="text-status-info" margin={{ top: 's' }}>
                  Try selecting "All Datastores" to see system-wide data, or import studies to this datastore.
                </Box>
              )}
            </Box>
          )}
        </Container>

        <Container 
          header={
            <Header 
              variant="h2"
              actions={
                <Button 
                  iconName="refresh" 
                  onClick={loadDashboardData}
                  loading={loading}
                  ariaLabel="Refresh studies per datastore"
                />
              }
            >
              Studies per Datastore
            </Header>          }
        >
          {dashboardStats.length > 0 ? (
            <SpaceBetween size="m">
              {dashboardStats.map((ds: any) => (
                <div key={ds.datastoreId}>
                  <Box variant="awsui-key-label">{ds.datastoreName}</Box>
                  <Box fontSize="heading-xl" fontWeight="bold">
                    {(ds.studyCount || 0).toLocaleString()}
                  </Box>
                  <Box variant="small" color="text-status-inactive">
                    {(ds.instanceCount || 0).toLocaleString()} instances
                  </Box>
                </div>
              ))}
            </SpaceBetween>
          ) : (
            <Box textAlign="center" padding="l">
              <Box variant="strong">No datastores</Box>
              <Box variant="p">
                Create datastores to see study counts
              </Box>
            </Box>
          )}
        </Container>
      </ColumnLayout>

      {/* Storage Growth Trend */}
      <Container 
        header={
          <Header 
            variant="h2"
            actions={
              <Button 
                iconName="refresh" 
                onClick={() => setGrowthDateRange({...growthDateRange})}
                loading={storageGrowthLoading}
                ariaLabel="Refresh storage growth trend"
              />
            }
          >
            Storage Growth Trend
          </Header>
        }
      >
        <SpaceBetween size="m">
          <DateRangePicker
            value={growthDateRange}
            onChange={({ detail }) => setGrowthDateRange(detail.value || { type: 'relative', amount: 7, unit: 'day' })}
            relativeOptions={[
              { key: 'previous-1-day', amount: 1, unit: 'day', type: 'relative' },
              { key: 'previous-7-days', amount: 7, unit: 'day', type: 'relative' },
              { key: 'previous-30-days', amount: 30, unit: 'day', type: 'relative' },
              { key: 'previous-3-months', amount: 90, unit: 'day', type: 'relative' },
              { key: 'previous-6-months', amount: 180, unit: 'day', type: 'relative' },
              { key: 'previous-12-months', amount: 365, unit: 'day', type: 'relative' }
            ]}
            i18nStrings={{
              todayAriaLabel: "Today",
              nextMonthAriaLabel: "Next month",
              previousMonthAriaLabel: "Previous month",
              customRelativeRangeDurationLabel: "Duration",
              customRelativeRangeDurationPlaceholder: "Enter duration",
              customRelativeRangeOptionLabel: "Custom range",
              customRelativeRangeOptionDescription: "Set a custom range in the past",
              customRelativeRangeUnitLabel: "Unit of time",
              formatRelativeRange: e => {
                const n = 1 === e.amount ? e.unit : `${e.unit}s`;
                return `Last ${e.amount} ${n}`;
              },
              formatUnit: (e, n) => (1 === n ? e : `${e}s`),
              dateTimeConstraintText: "Range is 1-366 days. Use YYYY/MM/DD format.",
              relativeModeTitle: "Relative range",
              absoluteModeTitle: "Absolute range",
              relativeRangeSelectionHeading: "Choose a range",
              startDateLabel: "Start date",
              endDateLabel: "End date",
              startTimeLabel: "Start time",
              endTimeLabel: "End time",
              clearButtonLabel: "Clear",
              cancelButtonLabel: "Cancel",
              applyButtonLabel: "Apply"
            }}
            isValidRange={range => {
              if (range?.type === 'absolute') {
                const [startDateWithoutTime] = range.startDate.split('T');
                const [endDateWithoutTime] = range.endDate.split('T');
                if (new Date(startDateWithoutTime) > new Date(endDateWithoutTime)) {
                  return { valid: false, errorMessage: 'Start date must be before end date' };
                }
              }
              return { valid: true };
            }}
            placeholder="Filter by date range"
            disabled={storageGrowthLoading}
          />
          
          {storageGrowthLoading ? (
            <Box textAlign="center" padding="l">
              <Spinner />
              <Box variant="p" margin={{ top: 's' }}>
                Loading storage growth data...
              </Box>
            </Box>
          ) : storageGrowthData.length > 0 ? (
            <LineChart
              series={(() => {
                const seriesByDatastore = new Map();
                storageGrowthData.forEach(item => {
                  if (!seriesByDatastore.has(item.datastoreId)) {
                    seriesByDatastore.set(item.datastoreId, {
                      title: item.datastoreName,
                      type: 'line' as const,
                      data: []
                    });
                  }
                  seriesByDatastore.get(item.datastoreId).data.push({
                    x: new Date(item.x),
                    y: item.y
                  });
                });
                return Array.from(seriesByDatastore.values());
              })()}
              height={300}
              xDomain={growthWindow ? [growthWindow.start, growthWindow.end] : undefined}
              xScaleType="time"
              yTitle="Storage (GB)"
              statusType="finished"
              legendTitle="Datastores"
              detailPopoverSeriesContent={({ series, y }) => ({
                key: series.title,
                value: `${y.toFixed(2)} GB`
              })}
            />
          ) : (
            <Box textAlign="center" padding="l">
              <Box variant="strong">No growth data available</Box>
              <Box variant="p">
                Select datastores and date range to view historical storage growth.
              </Box>
            </Box>
          )}
        </SpaceBetween>
      </Container>

      {/* Storage Changes (Deltas) */}
      <Container 
        header={
          <Header 
            variant="h2"
            actions={
              <Button 
                iconName="refresh" 
                onClick={() => setChangesDateRange({...changesDateRange})}
                loading={storageChangesLoading}
                ariaLabel="Refresh storage changes"
              />
            }
          >
            Storage Changes
          </Header>
        }
      >
        <SpaceBetween size="m">
          <DateRangePicker
            value={changesDateRange}
              onChange={({ detail }) => setChangesDateRange(detail.value || { type: 'relative', amount: 7, unit: 'day' })}
              relativeOptions={[
                { key: 'previous-1-day', amount: 1, unit: 'day', type: 'relative' },
                { key: 'previous-7-days', amount: 7, unit: 'day', type: 'relative' },
                { key: 'previous-30-days', amount: 30, unit: 'day', type: 'relative' },
                { key: 'previous-3-months', amount: 90, unit: 'day', type: 'relative' },
                { key: 'previous-6-months', amount: 180, unit: 'day', type: 'relative' },
                { key: 'previous-12-months', amount: 365, unit: 'day', type: 'relative' }
              ]}
              i18nStrings={{
                todayAriaLabel: "Today",
                nextMonthAriaLabel: "Next month",
                previousMonthAriaLabel: "Previous month",
                customRelativeRangeDurationLabel: "Duration",
                customRelativeRangeDurationPlaceholder: "Enter duration",
                customRelativeRangeOptionLabel: "Custom range",
                customRelativeRangeOptionDescription: "Set a custom range in the past",
                customRelativeRangeUnitLabel: "Unit of time",
                formatRelativeRange: e => {
                  const n = 1 === e.amount ? e.unit : `${e.unit}s`;
                  return `Last ${e.amount} ${n}`;
                },
                formatUnit: (e, n) => (1 === n ? e : `${e}s`),
                dateTimeConstraintText: "Range is 1-366 days. Use YYYY/MM/DD format.",
                relativeModeTitle: "Relative range",
                absoluteModeTitle: "Absolute range",
                relativeRangeSelectionHeading: "Choose a range",
                startDateLabel: "Start date",
                endDateLabel: "End date",
                startTimeLabel: "Start time",
                endTimeLabel: "End time",
                clearButtonLabel: "Clear",
                cancelButtonLabel: "Cancel",
                applyButtonLabel: "Apply"
              }}
              isValidRange={range => {
                if (range?.type === 'absolute') {
                  const [startDateWithoutTime] = range.startDate.split('T');
                  const [endDateWithoutTime] = range.endDate.split('T');
                  if (new Date(startDateWithoutTime) > new Date(endDateWithoutTime)) {
                    return { valid: false, errorMessage: 'Start date must be before end date' };
                  }
                }
                return { valid: true };
              }}
              placeholder="Filter by date range"
              disabled={storageChangesLoading}
            />
          
          {storageChangesLoading ? (
            <Box textAlign="center" padding="l">
              <Spinner />
              <Box variant="p" margin={{ top: 's' }}>
                Loading storage changes...
              </Box>
            </Box>
          ) : storageChangesData.length > 0 ? (
            <LineChart
              series={(() => {
                const seriesByDatastore = new Map();
                storageChangesData.forEach(item => {
                  if (!seriesByDatastore.has(item.datastoreId)) {
                    seriesByDatastore.set(item.datastoreId, {
                      title: item.datastoreName,
                      type: 'line' as const,
                      data: []
                    });
                  }
                  seriesByDatastore.get(item.datastoreId).data.push({
                    x: new Date(item.x),
                    y: item.y
                  });
                });
                return Array.from(seriesByDatastore.values());
              })()}
              height={300}
              xScaleType="time"
              yTitle="Change (GB)"
              statusType="finished"
              legendTitle="Datastores"
              detailPopoverSeriesContent={({ series, y }) => ({
                key: series.title,
                value: `${y >= 0 ? '+' : ''}${y.toFixed(3)} GB`
              })}
            />
          ) : (
            <Box textAlign="center" padding="l">
              <Box variant="strong">No change data available</Box>
              <Box variant="p">
                Select date range to view storage changes over time.
              </Box>
            </Box>
          )}
        </SpaceBetween>
      </Container>

    </SpaceBetween>
  );
};

export default Dashboard;
