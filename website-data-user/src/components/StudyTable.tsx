import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Table,
  Box,
  SpaceBetween,
  Button,
  Header,
  Pagination,
  CollectionPreferences,
  FormField,
  Input,
  DatePicker,
  ColumnLayout,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  SplitPanel,
  Modal,
  Badge,
  Alert
} from '@cloudscape-design/components';
import { ModalityBadge, ModalityBadges } from './ModalityBadge';
import SeriesThumbnail from './SeriesThumbnail';
import { fetchAuthSession } from 'aws-amplify/auth';
import { dicomwebService, DICOMStudy, StudySearchParams } from '../services/dicomwebService';
import { configService } from '../services/configService';
import { SourceType } from '../types';
import { useNonDicomImportV2 } from '../hooks/useNonDicomImportV2';
import AttachFilesModal from './AttachFilesModal';
import type { FixedStudy } from './NonDicomImportV2';
import ToolsPanel, { StudyTool } from './ToolsPanel';
import {
  kindOf, sourceKey, getSearchFields,
  DEFAULT_SEARCH_FIELD_IDS, PREFS_CHANGED_EVENT,
} from './dataUserPrefs';

interface StudyTableProps {
  sourceId: string;
  sourceType: SourceType;
  sourceName: string;
  userId: string;
  onSplitPanelChange?: (content: React.ReactNode) => void;
}

const ALL_COLUMNS = [
  { id: 'patientID', label: 'Patient ID', visible: true },
  { id: 'patientName', label: 'Patient Name', visible: true },
  { id: 'studyDate', label: 'Study Date', visible: true },
  { id: 'modality', label: 'Modality', visible: true },
  { id: 'studyDescription', label: 'Study Description', visible: true },
  { id: 'accessionNumber', label: 'Accession Number', visible: true },
  { id: 'referringPhysicianName', label: 'Referring Physician', visible: false },
  { id: 'patientBirthDate', label: 'Birth Date', visible: false },
  { id: 'numberOfStudyRelatedSeries', label: 'Series', visible: true },
  { id: 'numberOfStudyRelatedInstances', label: 'Instances', visible: true }
];

const PAGE_SIZE_OPTIONS = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 100, label: '100' }
];

const StudyTable: React.FC<StudyTableProps> = ({ sourceId, sourceType, sourceName, userId, onSplitPanelChange }) => {
  const [studies, setStudies] = useState<DICOMStudy[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<DICOMStudy[]>([]);
  const [persistentSelection, setPersistentSelection] = useState<DICOMStudy[]>([]);
  const [showSelectionModal, setShowSelectionModal] = useState(false);
  const [modalSelectedItems, setModalSelectedItems] = useState<DICOMStudy[]>([]);
  const [selectedStudyForSeries, setSelectedStudyForSeries] = useState<DICOMStudy | null>(null);
  const [expandedStudies, setExpandedStudies] = useState<Set<string>>(new Set());
  const [seriesData, setSeriesData] = useState<Map<string, any[]>>(new Map());
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set());
  const [instanceData, setInstanceData] = useState<Map<string, any[]>>(new Map());
  // Non-DICOM Import V2 "Attach files": offered only when this source is a
  // writable destination the user can store into (flag + /destinations).
  const { destinations: importDestinations } = useNonDicomImportV2();
  const importDest = importDestinations.find(d => d.kind === sourceType && d.id === sourceId);
  const [attachStudy, setAttachStudy] = useState<FixedStudy | null>(null);
  // canDownload on this storage/folder, as the server reports it. Download
  // apps are offered only when true; the download route enforces it anyway.
  const [canDownload, setCanDownload] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  
  // Filters
  const [patientId, setPatientId] = useState('');
  const [patientName, setPatientName] = useState('');
  const [studyDate, setStudyDate] = useState('');
  const [modality, setModality] = useState('');
  const [accessionNumber, setAccessionNumber] = useState('');
  const [studyDescription, setStudyDescription] = useState('');
  const [referringPhysician, setReferringPhysician] = useState('');

  // Per-source search-field selection: which of the catalogue fields appear in the
  // form. Editing moved to the Preferences modal; here we only READ and react to
  // its changes (live via PREFS_CHANGED_EVENT, and on tab/source switch). Unset =
  // the full form.
  const sk = useMemo(() => sourceKey(userId, kindOf(sourceType), sourceId), [userId, sourceType, sourceId]);
  const [enabledSearchFields, setEnabledSearchFields] = useState<string[]>(
    () => getSearchFields(sk) ?? DEFAULT_SEARCH_FIELD_IDS
  );
  useEffect(() => { setEnabledSearchFields(getSearchFields(sk) ?? DEFAULT_SEARCH_FIELD_IDS); }, [sk]);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sk: string | null } | undefined;
      // Re-read when this source changed, or on a broad change (sk === null).
      if (!detail || detail.sk === null || detail.sk === sk) {
        setEnabledSearchFields(getSearchFields(sk) ?? DEFAULT_SEARCH_FIELD_IDS);
      }
    };
    window.addEventListener(PREFS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PREFS_CHANGED_EVENT, onChange);
  }, [sk]);
  const showField = (id: string) => enabledSearchFields.includes(id);

  // A hidden field must not keep filtering: clear its value when it disappears.
  useEffect(() => {
    if (!showField('patientID')) setPatientId('');
    if (!showField('patientName')) setPatientName('');
    if (!showField('studyDate')) setStudyDate('');
    if (!showField('modality')) setModality('');
    if (!showField('accessionNumber')) setAccessionNumber('');
    if (!showField('studyDescription')) setStudyDescription('');
    if (!showField('referringPhysician')) setReferringPhysician('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledSearchFields]);
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => {
    const saved = localStorage.getItem(`pageSize-${sourceId}`);
    return saved ? parseInt(saved) : 20;
  });
  
  // Column preferences
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => {
    const saved = localStorage.getItem(`columns-${sourceId}`);
    return saved ? JSON.parse(saved) : ALL_COLUMNS.filter(c => c.visible).map(c => c.id);
  });

  const loadStudies = useCallback(async () => {
    setLoading(true);
    try {
      const params: StudySearchParams = {};
      if (patientId) params.PatientID = `*${patientId}*`;
      if (patientName) params.PatientName = `*${patientName}*`;
      if (studyDate) params.StudyDate = studyDate.replace(/-/g, '');
      if (modality) params.ModalitiesInStudy = modality;
      if (accessionNumber) params.AccessionNumber = `*${accessionNumber}*`;
      if (studyDescription) params.StudyDescription = `*${studyDescription}*`;
      if (referringPhysician) params.ReferringPhysicianName = `*${referringPhysician}*`;

      // Server-side pagination for ALL sources (datastore + virtual folder).
      // The DICOMweb /studies endpoint honors limit/offset; sending them lets
      // the pager fetch each page instead of pulling every study and slicing
      // client-side (which broke next-page navigation and, on large datastores,
      // hammered the server).
      params.limit = pageSize;
      params.offset = (currentPage - 1) * pageSize;

      const config = configService.getConfig();
      const data = sourceType === 'datastore'
        ? await dicomwebService.searchStudies(sourceId, params)
        : await dicomwebService.searchVirtualFolderStudies(sourceId, config.virtualFolderDicomWebUrl, params);
      setStudies(data);
      setSeriesData(new Map());
      setInstanceData(new Map());
    } catch (error) {
      console.error('Failed to load studies:', { errorType: error.name });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, sourceType, sourceName, patientId, patientName, studyDate, modality, accessionNumber, studyDescription, referringPhysician, currentPage, pageSize]);

  useEffect(() => {
    loadStudies();
  }, [sourceId, sourceType, loadStudies]);

  // Sync table selection with persistent selection when studies change
  useEffect(() => {
    const selected = studies.filter(s => 
      persistentSelection.find(ps => ps.studyInstanceUID === s.studyInstanceUID)
    );
    setSelectedItems(selected);
  }, [studies, persistentSelection]);

  useEffect(() => {
    let cancelled = false;
    setCanDownload(false);
    setDownloadError(null);
    dicomwebService.canDownload(sourceId).then(ok => { if (!cancelled) setCanDownload(ok); });
    return () => { cancelled = true; };
  }, [sourceId]);

  // Applications offered for this source: a 'download' app only with canDownload.
  const availableApps = () =>
    configService.getConfig().applications.filter(a => a.type !== 'download' || canDownload);

  // Clear all cached data when switching sources (tabs)
  useEffect(() => {
    setSelectedItems([]);
    setSelectedStudyForSeries(null);
    setSeriesData(new Map());
    setInstanceData(new Map());
    setExpandedStudies(new Set());
    setExpandedSeries(new Set());
    if (onSplitPanelChange) {
      onSplitPanelChange(null);
    }
  }, [sourceId, onSplitPanelChange]);

  useEffect(() => {
    if (selectedStudyForSeries && onSplitPanelChange) {
      const series = seriesData.get(selectedStudyForSeries.studyInstanceUID);
      if (series && series.length > 0) {
        onSplitPanelChange(renderSeriesTable(selectedStudyForSeries.studyInstanceUID));
      } else if (!series) {
        loadSeriesForStudy(selectedStudyForSeries.studyInstanceUID);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesData, selectedStudyForSeries, onSplitPanelChange, expandedSeries, instanceData, canDownload, downloading]);

  const handleSearch = () => {
    setCurrentPage(1);
    loadStudies();
  };

  const handleClearFilters = () => {
    setPatientId('');
    setPatientName('');
    setStudyDate('');
    setModality('');
    setAccessionNumber('');
    setStudyDescription('');
    setReferringPhysician('');
  };

  const handlePreferencesChange = (detail: any) => {
    if (detail.pageSize) {
      setPageSize(detail.pageSize);
      localStorage.setItem(`pageSize-${sourceId}`, String(detail.pageSize));
    }
    if (detail.visibleContent) {
      setVisibleColumns(detail.visibleContent);
      localStorage.setItem(`columns-${sourceId}`, JSON.stringify(detail.visibleContent));
    }
    if (detail.contentDisplay) {
      const orderedColumns = detail.contentDisplay.map((item: any) => item.id);
      setVisibleColumns(orderedColumns.filter((id: string) => detail.visibleContent?.includes(id) ?? true));
      localStorage.setItem(`columns-${sourceId}`, JSON.stringify(orderedColumns.filter((id: string) => detail.visibleContent?.includes(id) ?? true)));
    }
  };

  const loadSeriesForStudy = async (studyInstanceUID: string) => {
    if (seriesData.has(studyInstanceUID)) return;
    
    try {
      const config = configService.getConfig();
      const series = sourceType === 'datastore'
        ? await dicomwebService.searchSeries(sourceId, studyInstanceUID)
        : await dicomwebService.searchVirtualFolderSeries(sourceId, config.virtualFolderDicomWebUrl, studyInstanceUID);
      
      const seriesWithStudyUID = series.map(s => ({ ...s, studyInstanceUID }));
      setSeriesData(prev => new Map(prev).set(studyInstanceUID, seriesWithStudyUID));
    } catch (error) {
      console.error('Failed to load series:', error.message);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleExpandChange = async (studyInstanceUID: string, expanded: boolean) => {
    const newExpanded = new Set(expandedStudies);
    if (expanded) {
      newExpanded.add(studyInstanceUID);
      await loadSeriesForStudy(studyInstanceUID);
    } else {
      newExpanded.delete(studyInstanceUID);
    }
    setExpandedStudies(newExpanded);
  };

  const loadInstancesForSeries = async (studyInstanceUID: string, seriesInstanceUID: string) => {
    const key = `${studyInstanceUID}/${seriesInstanceUID}`;
    if (instanceData.has(key)) return;
    
    try {
      const config = configService.getConfig();
      const instances = sourceType === 'datastore'
        ? await dicomwebService.searchInstances(sourceId, studyInstanceUID, seriesInstanceUID)
        : await dicomwebService.searchVirtualFolderInstances(sourceId, config.virtualFolderDicomWebUrl, studyInstanceUID, seriesInstanceUID);
      
      setInstanceData(prev => new Map(prev).set(key, instances));
    } catch (error) {
      console.error('Failed to load instances:', error.message);
    }
  };

  const handleSeriesExpandChange = async (series: any, expanded: boolean) => {
    const key = series.seriesInstanceUID;
    const newExpanded = new Set(expandedSeries);
    if (expanded) {
      newExpanded.add(key);
      await loadInstancesForSeries(series.studyInstanceUID, series.seriesInstanceUID);
    } else {
      newExpanded.delete(key);
    }
    setExpandedSeries(newExpanded);
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getSeriesHeaderLabel = (columnId: string): string => {
    const labels: Record<string, string> = {
      'patientID': 'Series Number (0020,0011)',
      'patientName': 'Series Description (0008,103E)',
      'studyDate': 'Modality (0008,0060)',
      'studyDescription': 'Body Part Examined (0018,0015)',
      'modality': 'Specific Character Set (0008,0005)',
      'accessionNumber': 'Series Instance UID (0020,000E)',
      'referringPhysicianName': '',
      'numberOfStudyRelatedSeries': '',
      'numberOfStudyRelatedInstances': 'Number of Instances (0020,1209)'
    };
    return labels[columnId] || '';
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getInstanceHeaderLabel = (columnId: string): string => {
    const labels: Record<string, string> = {
      'patientID': 'Instance Number (0020,0013)',
      'patientName': 'SOP Class UID (0008,0016)',
      'studyDescription': 'Rows x Columns (0028,0010 x 0028,0011)',
      'accessionNumber': 'SOP Instance UID (0008,0018)'
    };
    return labels[columnId] || '';
  };

  const UID_RE = /^[0-9]+(\.[0-9]+)*$/;

  const downloadStudies = async (studies: DICOMStudy[]) => {
    if (!canDownload || downloading) return;
    setDownloadError(null);
    setDownloading(true);
    try {
      // One .zip per study, one after another (each is streamed by the server).
      for (const s of studies) {
        const uid = s.studyInstanceUID || '';
        if (!UID_RE.test(uid) || uid.length > 64) {
          throw new Error('Refusing to download: invalid study UID');
        }
        await dicomwebService.downloadStudy(sourceId, uid);
      }
    } catch (error: any) {
      setDownloadError(error?.message || 'Download failed.');
    } finally {
      setDownloading(false);
    }
  };

  const launchApplication = async (studies: DICOMStudy[], appId: string) => {
    try {
      const config = configService.getConfig();
      const app = config.applications.find(a => a.id === appId);
      if (app?.type === 'download') {
        await downloadStudies(studies);
        return;
      }
      const session = await fetchAuthSession();
      const token = session.tokens?.accessToken?.toString() || '';
      
      if (app?.url) {
        // External viewers (OHIF, SLIM) resolve DICOMweb by the SAME key the
        // data-user browse calls and the OHIF dataSource config use: the
        // internal UUID on /dicomweb/{id}. A virtual folder is served by the
        // unified dicomweb-s3 container at /dicomweb/{vfId} exactly like a
        // datastore — so {datastoreId} must be the VF's UUID (sourceId), NEVER
        // its display name. Using the name produced /dicomweb/{vf-name}, which
        // the container rejects ("Invalid path format. Expected
        // /dicomweb/{datastoreId}/..."), breaking VF studies in OHIF/SLIM while
        // the in-app table (which already uses sourceId) worked.
        const datastoreId = sourceId;
        // Security: UIDs and the storage/folder id are substituted into the
        // viewer URL, so anything but a DICOM UID / plain id could rewrite it
        // (e.g. a UID carrying "?server=https://evil/&" redirects SLIM and the
        // token). Refuse to launch instead.
        const bad = studies.filter(s => !UID_RE.test(s.studyInstanceUID || '') || (s.studyInstanceUID || '').length > 64);
        if (bad.length > 0 || !/^[A-Za-z0-9-]+$/.test(datastoreId || '')) {
          console.error('Refusing to launch viewer: invalid study UID or storage id');
          return;
        }
        const studyUIDs = studies.map(s => s.studyInstanceUID).join(',');
        // Replace placeholders in URL
        let appUrl = app.url
          .replace('{ohifUrl}', config.ohifViewerUrl || '')
          .replace('{ohifViewerUrl}', config.ohifViewerUrl || '')
          .replace('{slimViewerUrl}', config.slimViewerUrl || '')
          .replace('{dicomWebUrl}', config.dicomWebUrl || '')
          .replace('{virtualFolderDicomWebUrl}', config.virtualFolderDicomWebUrl || '')
          .replace('{datastoreId}', datastoreId || '')
          .replace('{StudyUIDs}', studyUIDs)
          .replace('{token}', encodeURIComponent(token));
        // Process {URLEncode(...)} directives
        appUrl = appUrl.replace(/\{URLEncode\(([^)]+)\)\}/g, (_, inner) => encodeURIComponent(inner));
        
        window.open(appUrl, '_blank');
      }
    } catch (error) {
      console.error('Failed to launch application:', error.message);
    }
  };

  // Kitware VolView (3D/volume viewer, /volview/): one study per launch.
  // DICOMweb and VolView are served from the SAME origin, so VolView attaches
  // the bearer token to its DICOMweb calls (its build is patched to send it to
  // no other origin) and no CORS is involved. Same id/UID checks as the other
  // viewer launches: a UID or id that is not a plain DICOM UID /
  // UUID could rewrite the launch URL.
  const openInVolView = async (study: DICOMStudy) => {
    try {
      const base = configService.getConfig().volviewViewerUrl;
      if (!base) return;
      const uid = study.studyInstanceUID || '';
      if (!/^[0-9]+(\.[0-9]+)*$/.test(uid) || uid.length > 64 || !/^[A-Za-z0-9-]+$/.test(sourceId || '')) {
        console.error('Refusing to launch VolView: invalid study UID or storage id');
        return;
      }
      const viewer = new URL(base, window.location.href);
      const dicomweb = `${viewer.origin}/dicomweb/${sourceId}/studies/${uid}`;
      const session = await fetchAuthSession();
      const token = session.tokens?.accessToken?.toString() || '';
      viewer.search = `?dicomweb=${encodeURIComponent(dicomweb)}`;
      // Token in the fragment: never sent in a request (no access logs / Referer).
      viewer.hash = `token=${encodeURIComponent(token)}`;
      window.open(viewer.toString(), '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error('Failed to launch VolView:', (error as Error).message);
    }
  };

  // Every tool on the study table, for the Tools container (ToolsPanel).
  // multi: whether one launch can take several studies. OHIF takes a list of
  // StudyInstanceUIDs and Download loops over the studies; SLIM's /studies/{uid}
  // route, VolView and Attach files take exactly one. A config entry can
  // override this with multiStudy.
  const studyTools: StudyTool[] = [
    ...availableApps().map(app => ({
      id: app.id,
      label: app.name,
      iconName: app.icon || (app.type === 'download' ? 'download' : 'multiscreen'),
      multi: app.multiStudy ?? app.type !== 'slim',
      loading: app.type === 'download' ? downloading : undefined,
      run: () => { if (persistentSelection.length > 0) launchApplication(persistentSelection, app.id); },
    })),
    ...(configService.getConfig().volviewViewerUrl ? [{
      id: 'volview', label: 'VolView', iconName: 'external', multi: false,
      run: () => { const s = persistentSelection[0]; if (s && persistentSelection.length === 1) openInVolView(s); },
    }] : []),
    ...(importDest ? [{
      id: 'attach-files', label: 'Attach files', iconName: 'upload', multi: false,
      run: () => {
        const s = persistentSelection[0];
        if (!s || persistentSelection.length !== 1) return;
        setAttachStudy({
          studyInstanceUID: s.studyInstanceUID, patientId: s.patientID || '', patientName: s.patientName,
          birthDate: s.patientBirthDate, studyDescription: s.studyDescription, studyDate: s.studyDate,
          accessionNumber: s.accessionNumber,
        });
      },
    }] : []),
  ];

  const getDefaultAppForModality = (modality: string): string => {
    const prefs: Record<string, string[]> = JSON.parse(localStorage.getItem('modalityAppPreferences2') || '{}');
    // Ignore a saved default that is not offered here (e.g. 'download' on a
    // source without canDownload).
    const apps = availableApps();
    const known = new Set(apps.map(a => a.id));
    const entries = Object.entries(prefs).filter(([id]) => known.has(id));
    const code = modality?.toUpperCase();
    const specific = entries.find(([, codes]) => codes.includes(code));
    if (specific) return specific[0];
    const all = entries.find(([, codes]) => codes.includes('__ALL__'));
    if (all) return all[0];
    return apps.find(a => a.type !== 'download')?.id || apps[0]?.id || 'ohif';
  };

  const renderSeriesTable = (studyInstanceUID: string) => {
    const series = seriesData.get(studyInstanceUID) || [];
    if (series.length === 0) return null;

    const study = studies.find(s => s.studyInstanceUID === studyInstanceUID);
    const config = configService.getConfig();

    const seriesColumns = [
      { id: 'thumbnail', header: '', width: 50, cell: (item: any) => {
        if (item.isInstanceHeader || item.isInstanceRow) return '';
        if (sourceType !== 'datastore') return '';
        return <SeriesThumbnail datastoreId={sourceId}
          studyInstanceUID={studyInstanceUID} seriesInstanceUID={item.seriesInstanceUID} />;
      }},
      { id: 'seriesNumber', header: 'Series Number', cell: (item: any) => {
        if (item.isInstanceHeader) return <strong>Instance Number</strong>;
        if (item.isInstanceRow) return item.instanceNumber || '-';
        return item.seriesNumber || '-';
      }},
      { id: 'seriesDescription', header: 'Series Description', cell: (item: any) => {
        if (item.isInstanceHeader) return <strong>SOP Class UID</strong>;
        if (item.isInstanceRow) return item.sopClassUID || '-';
        return item.seriesDescription || '-';
      }},
      { id: 'modality', header: 'Modality', cell: (item: any) => {
        if (item.isInstanceHeader) return <strong>Dimensions</strong>;
        if (item.isInstanceRow) return item.rows && item.columns ? `${item.rows}x${item.columns}` : '-';
        return item.modality ? <ModalityBadge modality={item.modality} /> : '-';
      }},
      { id: 'bodyPartExamined', header: 'Body Part Examined', cell: (item: any) => {
        if (item.isInstanceHeader) return <strong>SOP Instance UID</strong>;
        if (item.isInstanceRow) return item.sopInstanceUID || '-';
        return item.bodyPartExamined || '-';
      }},
      { id: 'specificCharacterSet', header: 'Character Set', cell: (item: any) => {
        if (item.isInstanceHeader || item.isInstanceRow) return '';
        return item.specificCharacterSet || '-';
      }},
      { id: 'numberOfSeriesRelatedInstances', header: 'Instances', cell: (item: any) => {
        if (item.isInstanceHeader || item.isInstanceRow) return '';
        return item.numberOfSeriesRelatedInstances || '-';
      }},
      { id: 'seriesInstanceUID', header: 'Series Instance UID', cell: (item: any) => {
        if (item.isInstanceHeader || item.isInstanceRow) return '';
        return item.seriesInstanceUID || '-';
      }}
    ];

    return (
      <SpaceBetween size="xs">
      {canDownload && study && (
        <Box padding={{ left: 's', top: 'xs' }}>
          <Button iconName="download" loading={downloading} onClick={() => downloadStudies([study])}>
            Download study (.zip)
          </Button>
        </Box>
      )}
      <Table
        variant="embedded"
        columnDefinitions={seriesColumns}
        items={series}
        expandableRows={{
          getItemChildren: (seriesItem: any) => {
            if (seriesItem.isInstanceRow || seriesItem.isInstanceHeader) return [];
            const key = `${studyInstanceUID}/${seriesItem.seriesInstanceUID}`;
            const instances = instanceData.get(key) || [];
            return [{ isInstanceHeader: true }, ...instances.map((i: any) => ({ ...i, isInstanceRow: true }))];
          },
          isItemExpandable: (seriesItem: any) => !seriesItem.isInstanceRow && !seriesItem.isInstanceHeader && (seriesItem.numberOfSeriesRelatedInstances || 0) > 0,
          expandedItems: Array.from(expandedSeries).map(uid => series.find((s: any) => s.seriesInstanceUID === uid)).filter(Boolean) as any[],
          onExpandableItemToggle: ({ detail }) => handleSeriesExpandChange(detail.item, detail.expanded),
        }}
        contentDensity="compact"
      />
      </SpaceBetween>
    );
  };

  // All sources are server-paginated (limit/offset sent to /studies), so the
  // fetched `studies` IS the current page — never slice it client-side. A full
  // page implies there may be a next page (openEnd); a short page is the last.
  const isServerPaginated = true;
  const paginatedStudies = studies;
  const totalPages = studies.length >= pageSize ? currentPage + 1 : currentPage;

  const columnDefinitions = [
    {
      id: 'launch',
      header: '',
      width: 40,
      cell: (item: DICOMStudy) => (
        <Button
          variant="inline-icon"
          iconName="multiscreen"
          onClick={() => {
            const appId = getDefaultAppForModality(item.modality || '');
            launchApplication([item], appId);
          }}
        />
      )
    },
    ...visibleColumns
      .map(colId => ALL_COLUMNS.find(col => col.id === colId))
      .filter((col): col is typeof ALL_COLUMNS[0] => col !== undefined)
      .map(col => ({
        id: col.id,
        header: col.label,
        cell: (item: any) => {
          const value = (item as any)[col.id];
          if (col.id === 'modality') {
            return item.modalitiesInStudy?.length > 0
              ? <ModalityBadges modalities={item.modalitiesInStudy} />
              : item.modality ? <ModalityBadge modality={item.modality} /> : '-';
          }
          if (col.id === 'studyDate' && value) {
            return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
          }
          if (col.id === 'patientBirthDate' && value) {
            return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
          }
          return value || '-';
        },
        sortingField: col.id
      }))
  ];

  return (
    <Box padding="s">
      <SpaceBetween size="m">
      <Box padding="s" variant="div">
        <ColumnLayout columns={4} variant="text-grid">
          {showField('patientID') && (
          <FormField label="Patient ID">
            <Input value={patientId} onChange={({ detail }) => setPatientId(detail.value)} placeholder="Search..." />
          </FormField>
          )}
          {showField('patientName') && (
          <FormField label="Patient Name">
            <Input value={patientName} onChange={({ detail }) => setPatientName(detail.value)} placeholder="Search..." />
          </FormField>
          )}
          {showField('studyDate') && (
          <FormField label="Study Date">
            <DatePicker value={studyDate} onChange={({ detail }) => setStudyDate(detail.value)} placeholder="YYYY-MM-DD" />
          </FormField>
          )}
          {showField('modality') && (
          <FormField label="Modality">
            <Input value={modality} onChange={({ detail }) => setModality(detail.value)} placeholder="CT, MR, US..." />
          </FormField>
          )}
          {showField('accessionNumber') && (
          <FormField label="Accession Number">
            <Input value={accessionNumber} onChange={({ detail }) => setAccessionNumber(detail.value)} placeholder="Search..." />
          </FormField>
          )}
          {showField('studyDescription') && (
          <FormField label="Study Description">
            <Input value={studyDescription} onChange={({ detail }) => setStudyDescription(detail.value)} placeholder="Search..." />
          </FormField>
          )}
          {showField('referringPhysician') && (
          <FormField label="Referring Physician">
            <Input value={referringPhysician} onChange={({ detail }) => setReferringPhysician(detail.value)} placeholder="Search..." />
          </FormField>
          )}
          <FormField label=" ">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={handleSearch} variant="primary">Search</Button>
              <Button onClick={handleClearFilters}>Clear</Button>
              <Button onClick={loadStudies} iconName="refresh">Refresh</Button>
            </SpaceBetween>
          </FormField>
        </ColumnLayout>
        <Box padding={{ top: 'l' }}>
          <SpaceBetween direction="horizontal" size="xs">
            <Button 
              onClick={() => {
                setModalSelectedItems([]);
                setShowSelectionModal(true);
              }}
              disabled={persistentSelection.length === 0}
            >
              Selection <Badge color="blue">{persistentSelection.length}</Badge>
            </Button>
            <ToolsPanel tools={studyTools} selectedCount={persistentSelection.length} userId={userId} sourceKey={sk} />
          </SpaceBetween>
        </Box>
      </Box>

      {downloadError && (
        <Alert type="error" dismissible onDismiss={() => setDownloadError(null)} header="Download failed">
          {downloadError}
        </Alert>
      )}
      
      <div style={{ maxHeight: '70vh', overflowY: 'auto', overflowX: 'auto' }}>
      <Table
        variant="embedded"
        loading={loading}
        items={paginatedStudies}
        selectedItems={selectedItems}
        trackBy="studyInstanceUID"
        onSelectionChange={({ detail }) => {
          setSelectedItems(detail.selectedItems);
          
          // Merge with persistent selection
          const newSelection = [...persistentSelection];
          detail.selectedItems.forEach(item => {
            if (!newSelection.find(s => s.studyInstanceUID === item.studyInstanceUID)) {
              newSelection.push(item);
            }
          });
          // Remove deselected items
          const deselected = persistentSelection.filter(
            ps => !detail.selectedItems.find(s => s.studyInstanceUID === ps.studyInstanceUID) &&
                  paginatedStudies.find(p => p.studyInstanceUID === ps.studyInstanceUID)
          );
          const finalSelection = newSelection.filter(
            s => !deselected.find(d => d.studyInstanceUID === s.studyInstanceUID)
          );
          setPersistentSelection(finalSelection);
          
          if (detail.selectedItems.length === 1) {
            const study = detail.selectedItems[0];
            setSelectedStudyForSeries(study);
            loadSeriesForStudy(study.studyInstanceUID);
          } else {
            setSelectedStudyForSeries(null);
            if (onSplitPanelChange) {
              onSplitPanelChange(null);
            }
          }
        }}
        selectionType="multi"
        columnDefinitions={columnDefinitions}
        pagination={
          <Pagination
            currentPageIndex={currentPage}
            pagesCount={totalPages}
            openEnd={isServerPaginated && studies.length >= pageSize}
            onChange={({ detail }) => setCurrentPage(detail.currentPageIndex)}
          />
        }
        preferences={
          <CollectionPreferences
            title="Preferences"
            confirmLabel="Confirm"
            cancelLabel="Cancel"
            preferences={{ 
              pageSize, 
              visibleContent: visibleColumns,
              contentDisplay: visibleColumns.map(id => ({ id, visible: true }))
            }}
            onConfirm={({ detail }) => handlePreferencesChange(detail)}
            pageSizePreference={{ title: 'Page size', options: PAGE_SIZE_OPTIONS }}
            visibleContentPreference={{
              title: 'Visible columns',
              options: [{ label: 'Columns', options: ALL_COLUMNS.map(c => ({ id: c.id, label: c.label })) }]
            }}
            contentDisplayPreference={{
              title: 'Column order',
              description: 'Drag and drop to reorder columns',
              options: ALL_COLUMNS.map(c => ({ id: c.id, label: c.label }))
            }}
          />
        }
        empty={
          <Box textAlign="center" color="inherit">
            <b>No studies</b>
            <Box padding={{ bottom: 's' }} variant="p" color="inherit">
              No studies found. Try adjusting your search filters.
            </Box>
          </Box>
        }
        contentDensity="compact"
      />
      </div>
      
      <Modal
        visible={showSelectionModal}
        onDismiss={() => setShowSelectionModal(false)}
        size="max"
        header="Selected Studies"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button 
                variant="normal"
                onClick={() => {
                  const toRemove = modalSelectedItems.map(s => s.studyInstanceUID);
                  setPersistentSelection(persistentSelection.filter(s => !toRemove.includes(s.studyInstanceUID)));
                  setModalSelectedItems([]);
                }}
                disabled={modalSelectedItems.length === 0}
              >
                Remove Selected
              </Button>
              <Button 
                variant="normal"
                onClick={() => {
                  setPersistentSelection([]);
                  setShowSelectionModal(false);
                }}
              >
                Clear All
              </Button>
              <Button variant="primary" onClick={() => setShowSelectionModal(false)}>Close</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Table
          variant="embedded"
          items={persistentSelection}
          selectedItems={modalSelectedItems}
          onSelectionChange={({ detail }) => setModalSelectedItems(detail.selectedItems)}
          selectionType="multi"
          columnDefinitions={[
            { id: 'patientID', header: 'Patient ID', cell: (item: DICOMStudy) => item.patientID || '-' },
            { id: 'patientName', header: 'Patient Name', cell: (item: DICOMStudy) => item.patientName || '-' },
            { id: 'studyDate', header: 'Study Date', cell: (item: DICOMStudy) => item.studyDate || '-' },
            { id: 'modality', header: 'Modality', cell: (item: DICOMStudy) => item.modalitiesInStudy?.length > 0
              ? <ModalityBadges modalities={item.modalitiesInStudy} />
              : item.modality ? <ModalityBadge modality={item.modality} /> : '-' },
            { id: 'accessionNumber', header: 'Accession Number', cell: (item: DICOMStudy) => item.accessionNumber || '-' },
            { id: 'studyDescription', header: 'Study Description', cell: (item: DICOMStudy) => item.studyDescription || '-' },
            { id: 'numberOfStudyRelatedSeries', header: 'Series', cell: (item: DICOMStudy) => item.numberOfStudyRelatedSeries || '-' },
            { id: 'numberOfStudyRelatedInstances', header: 'Instances', cell: (item: DICOMStudy) => item.numberOfStudyRelatedInstances || '-' }
          ]}
          empty={
            <Box textAlign="center" color="inherit">
              <b>No studies selected</b>
            </Box>
          }
        />
      </Modal>

      {importDest && attachStudy && (
        <AttachFilesModal visible destination={importDest} study={attachStudy} onClose={() => setAttachStudy(null)} />
      )}
      
    </SpaceBetween>
    </Box>
  );
};

export default StudyTable;
