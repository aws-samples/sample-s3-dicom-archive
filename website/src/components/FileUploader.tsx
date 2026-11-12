import React, { useState, useRef } from 'react';
import {
  Modal,
  Box,
  SpaceBetween,
  Button,
  ProgressBar,
  Alert,
  Container,
  Header,
  FormField,
  Input,
  Table,
  Checkbox,
  StatusIndicator,
  Link
} from '@cloudscape-design/components';
import { uploadService, UploadFile, UploadProgress } from '../services/uploadService';
import { parseDicomFiles, DicomStudy, DicomSeries } from '../utils/dicomParser';

interface FileUploaderProps {
  visible: boolean;
  onDismiss: () => void;
  onUploadComplete: (s3Paths: string[]) => void;
  datastoreId: string;
  datastoreName: string;
}

export const FileUploader: React.FC<FileUploaderProps> = ({ 
  visible, 
  onDismiss, 
  onUploadComplete,
  datastoreId,
  datastoreName
}) => {
  const [files, setFiles] = useState<File[]>([]);
  const [jobNamePrefix, setJobNamePrefix] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Map<string, UploadProgress>>(new Map());
  const [error, setError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [currentBatch, setCurrentBatch] = useState(1);
  const [totalBatches, setTotalBatches] = useState(1);
  const [parsing, setParsing] = useState(false);
  const [studies, setStudies] = useState<Map<string, DicomStudy>>(new Map());
  const [rejectedCount, setRejectedCount] = useState(0);
  const [currentSeriesProgress, setCurrentSeriesProgress] = useState({ completed: 0, total: 0 });
  const [uploadComplete, setUploadComplete] = useState(false);
  const [selectedSeriesUIDs, setSelectedSeriesUIDs] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    setError('');

    const items = e.dataTransfer.items;
    if (!items) return;

    setParsing(true);
    const files: File[] = [];
    
    // Process all items recursively
    const promises: Promise<void>[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i].webkitGetAsEntry();
      if (item) {
        promises.push(traverseFileTree(item, files));
      }
    }
    
    await Promise.all(promises);
    
    if (files.length > 0) {
      await validateAndSetFiles(files);
    } else {
      setParsing(false);
    }
  };

  const traverseFileTree = async (item: any, files: File[]): Promise<void> => {
    return new Promise((resolve) => {
      if (item.isFile) {
        item.file((file: File) => {
          files.push(file);
          resolve();
        }, () => resolve());
      } else if (item.isDirectory) {
        const dirReader = item.createReader();
        const readEntries = () => {
          dirReader.readEntries(async (entries: any[]) => {
            if (entries.length === 0) {
              resolve();
              return;
            }
            for (const entry of entries) {
              await traverseFileTree(entry, files);
            }
            readEntries(); // Continue reading if more entries exist
          }, () => resolve());
        };
        readEntries();
      } else {
        resolve();
      }
    });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError('');
    if (e.target.files && e.target.files.length > 0) {
      await validateAndSetFiles(Array.from(e.target.files));
    }
  };

  const validateAndSetFiles = async (fileList: File[]) => {
    // Combine with existing files
    const allFiles = [...files, ...fileList];
    
    // Validate file count
    if (allFiles.length > 5000) {
      setError(`Too many files selected. Maximum 5000 files allowed, got ${allFiles.length}`);
      return;
    }

    // Validate total size
    const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
    const maxSize = 10 * 1024 * 1024 * 1024; // 10GB
    if (totalSize > maxSize) {
      setError(`Total size exceeds 10GB limit. Selected: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)}GB`);
      return;
    }

    setFiles(allFiles);
    
    // Parse DICOM files (parse all files including existing)
    setParsing(true);
    try {
      const { studies: parsedStudies, rejectedCount: rejected } = await parseDicomFiles(allFiles);
      
      // Preserve expanded state and status from existing studies
      parsedStudies.forEach((newStudy, studyUID) => {
        const existingStudy = studies.get(studyUID);
        if (existingStudy) {
          newStudy.expanded = existingStudy.expanded;
          newStudy._type = 'study';
          // Preserve series status
          newStudy.series.forEach((newSeries, seriesUID) => {
            const existingSeries = existingStudy.series.get(seriesUID);
            if (existingSeries) {
              newSeries.status = existingSeries.status;
            }
            newSeries._type = 'series';
          });
        }
      });
      
      setStudies(parsedStudies);
      setRejectedCount(rejected);
      
      // Auto-select all series by default
      const allSeriesUIDs = new Set<string>();
      parsedStudies.forEach(study => {
        study.series.forEach(series => {
          allSeriesUIDs.add(series.seriesInstanceUID);
        });
      });
      setSelectedSeriesUIDs(allSeriesUIDs);
      
      if (parsedStudies.size === 0) {
        setError('No valid DICOM files found');
      }
    } catch (err: any) {
      setError(`Failed to parse DICOM files: ${err.message}`);
    } finally {
      setParsing(false);
    }
  };

  const handleUpload = async () => {
    // Validate at least one series is selected
    if (selectedSeriesUIDs.size === 0) {
      setError('Please select at least one study or series to upload');
      return;
    }

    setUploading(true);
    setError('');
    abortControllerRef.current = new AbortController();

    try {
      const timestamp = Date.now();
      const allS3Paths: string[] = [];
      let seriesIndex = 0;
      const totalSeries = selectedSeriesUIDs.size;
      
      // Generate uploadId once for this upload session
      const sessionUploadId = Math.random().toString(36).substring(2, 8).toUpperCase();
      
      console.log('Starting upload:', { totalSeries, uploadId: sessionUploadId, selectedSeriesUIDs: Array.from(selectedSeriesUIDs) });

      // Process studies sequentially
      for (const study of Array.from(studies.values())) {
        if (abortControllerRef.current.signal.aborted) break;

        // Get all selected series for this study
        const studySeries = Array.from(study.series.values()).filter(s => selectedSeriesUIDs.has(s.seriesInstanceUID));
        if (studySeries.length === 0) continue;

        // Pre-fetch upload URLs for all series in parallel. Each file carries a
        // stable clientId + its DICOM identity; the API derives the archive key
        // (YYYY/MM/DD/study/series/sop.dcm, or study/series/sop.dcm without a
        // parseable StudyDate) and presigns a PUT straight into the datastore's
        // archive bucket — s3-ingest indexes it from the S3 event.
        const seriesUploadData = await Promise.all(
          studySeries.map(async (series) => {
            const seriesFiles = series.instances.map(inst => ({
              file: inst.file,
              clientId: `${study.studyInstanceUID}/${series.seriesInstanceUID}/${inst.fileName}`,
              studyInstanceUID: study.studyInstanceUID,
              seriesInstanceUID: series.seriesInstanceUID,
              sopInstanceUID: inst.sopInstanceUID,
              studyDate: study.studyDate
            }));

            const response = await uploadService.generateUploadUrlsForSeries(
              seriesFiles,
              datastoreId
            );

            return { series, seriesFiles, response };
          })
        );

        // Upload series sequentially
        for (const { series, seriesFiles, response } of seriesUploadData) {
          if (abortControllerRef.current.signal.aborted) break;

          seriesIndex++;

          try {
            // Update series status and reset progress for this series
            updateSeriesStatus(study.studyInstanceUID, series.seriesInstanceUID, 'uploading');
            setCurrentSeriesProgress({ completed: 0, total: 0 });

            // Upload files directly into the archive bucket
            await uploadService.uploadFilesForSeries(
              seriesFiles,
              response.uploadUrls,
              abortControllerRef.current.signal,
              (completed, total) => {
                setCurrentSeriesProgress({ completed, total });
              }
            );

            // Check if cancelled after upload
            if (abortControllerRef.current.signal.aborted) {
              updateSeriesStatus(study.studyInstanceUID, series.seriesInstanceUID, 'failed');
              break;
            }

            // No import job: the archive bucket's S3 ObjectCreated events drive
            // s3-ingest, which populates the DICOM index automatically.
            updateSeriesStatus(study.studyInstanceUID, series.seriesInstanceUID, 'completed');
            // Record the archive prefix of this series for the completion summary.
            const firstKey = response.uploadUrls[0]?.key || `${study.studyInstanceUID}/${series.seriesInstanceUID}`;
            allS3Paths.push(`s3://${response.bucketName}/${firstKey.split('/').slice(0, -1).join('/')}/`);

          } catch (err: any) {
            console.error(`Failed to upload series ${series.seriesInstanceUID}:`, err);
            updateSeriesStatus(study.studyInstanceUID, series.seriesInstanceUID, 'failed');
            // Continue with next series
          }
        }
      }

      // Success
      if (allS3Paths.length > 0) {
        onUploadComplete(allS3Paths);
      }
      
      const failedSeries = Array.from(studies.values()).flatMap(study => 
        Array.from(study.series.values()).filter(s => selectedSeriesUIDs.has(s.seriesInstanceUID) && s.status === 'failed')
      ).length;
      if (failedSeries > 0) {
        setError(`${allS3Paths.length} series uploaded successfully, ${failedSeries} failed`);
      }
      
      setUploadComplete(true);

    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      setCurrentSeriesProgress({ completed: 0, total: 0 });
      abortControllerRef.current = null;
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setUploading(false);
    setCurrentSeriesProgress({ completed: 0, total: 0 });
  };

  const handleClose = () => {
    setFiles([]);
    setJobNamePrefix('');
    setStudies(new Map());
    setRejectedCount(0);
    setUploadProgress(new Map());
    setCurrentSeriesProgress({ completed: 0, total: 0 });
    setUploadComplete(false);
    setSelectedSeriesUIDs(new Set());
    setError('');
    setUploading(false);
    setParsing(false);
    onDismiss();
  };

  const updateSeriesStatus = (studyUID: string, seriesUID: string, status: 'pending' | 'uploading' | 'completed' | 'failed') => {
    setStudies(prev => {
      const newStudies = new Map(prev);
      const study = newStudies.get(studyUID);
      if (study) {
        const series = study.series.get(seriesUID);
        if (series) {
          series.status = status;
        }
      }
      return newStudies;
    });
  };

  const toggleStudyExpanded = (studyUID: string) => {
    setStudies(prev => {
      const newStudies = new Map();
      prev.forEach((study, uid) => {
        if (uid === studyUID) {
          newStudies.set(uid, { ...study, expanded: !study.expanded, _type: 'study' });
        } else {
          newStudies.set(uid, study);
        }
      });
      return newStudies;
    });
  };

  const getStudyStatus = (study: DicomStudy): 'pending' | 'uploading' | 'completed' | 'failed' => {
    const seriesArray = Array.from(study.series.values());
    if (seriesArray.every(s => s.status === 'completed')) return 'completed';
    if (seriesArray.some(s => s.status === 'failed')) return 'failed';
    if (seriesArray.some(s => s.status === 'uploading')) return 'uploading';
    return 'pending';
  };

  const getStudyModalities = (study: DicomStudy): string => {
    const modalities = new Set<string>();
    study.series.forEach(series => {
      if (series.modality) modalities.add(series.modality);
    });
    return Array.from(modalities).join('/');
  };

  const getStudyInstanceCount = (study: DicomStudy): number => {
    return Array.from(study.series.values()).reduce((sum, series) => sum + series.instances.length, 0);
  };

  const renderStatusIcon = (status: 'pending' | 'uploading' | 'completed' | 'failed') => {
    if (status === 'completed') return <StatusIndicator type="success">✓</StatusIndicator>;
    if (status === 'uploading') return <StatusIndicator type="in-progress">Uploading</StatusIndicator>;
    if (status === 'failed') return <StatusIndicator type="error">Failed</StatusIndicator>;
    return null;
  };

  const getOverallProgress = () => {
    let totalInstances = 0;
    let completedInstances = 0;
    let failedInstances = 0;

    studies.forEach(study => {
      study.series.forEach(series => {
        if (selectedSeriesUIDs.has(series.seriesInstanceUID)) {
          const instanceCount = series.instances.length;
          totalInstances += instanceCount;
          
          if (series.status === 'completed') {
            completedInstances += instanceCount;
          } else if (series.status === 'failed') {
            failedInstances += instanceCount;
          } else if (series.status === 'uploading') {
            // Add progress from currently uploading series
            completedInstances += currentSeriesProgress.completed;
          }
        }
      });
    });

    return { 
      totalInstances, 
      completedInstances, 
      failedInstances 
    };
  };

  return (
    <Modal
      visible={visible}
      onDismiss={uploading ? undefined : handleClose}
      header={`Upload DICOM Files to ${datastoreName}`}
      size="max"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleUpload}
              disabled={studies.size === 0 || uploading || parsing || uploadComplete}
              loading={uploading}
            >
              {uploadComplete ? 'Upload Complete' : uploading ? 'Uploading...' : 'Start Upload'}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError('')}>
            {error}
          </Alert>
        )}

        <FormField label="Job Name Prefix (Optional)" description="Prefix for import job names">
          <Input
            value={jobNamePrefix}
            onChange={({ detail }) => setJobNamePrefix(detail.value)}
            placeholder="e.g., CT-Chest (defaults to UserUpload if empty)"
            disabled={uploading}
          />
        </FormField>

        <Container>
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            style={{
              border: `2px dashed ${dragActive ? '#0972d3' : '#d5dbdb'}`,
              borderRadius: '8px',
              padding: '40px',
              textAlign: 'center',
              backgroundColor: dragActive ? '#f0f8ff' : 'transparent',
              cursor: 'pointer'
            }}
            onClick={() => !uploading && fileInputRef.current?.click()}
          >
            <SpaceBetween size="s">
              <Box variant="h3">Drag and drop DICOM files or folders here</Box>
              <Box variant="p" color="text-body-secondary">
                Files will be validated and organized by study
              </Box>
              <Box variant="small" color="text-body-secondary">
                Maximum 5000 files, 10GB total
              </Box>
            </SpaceBetween>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              style={{ display: 'none' }}
              disabled={uploading}
            />
          </div>
        </Container>

        {parsing && studies.size > 0 && (
          <Alert type="info">
            Processing {files.length} files...
          </Alert>
        )}

        {parsing && studies.size === 0 && (
          <Container>
            <StatusIndicator type="in-progress">Parsing DICOM files...</StatusIndicator>
          </Container>
        )}

        {rejectedCount > 0 && (
          <Alert type="warning">
            {rejectedCount} non-DICOM file(s) were skipped
          </Alert>
        )}

        {studies.size > 0 && (
          <Container header={<Header variant="h3">DICOM Studies</Header>}>
            <SpaceBetween size="s">
              <Box float="right">
                <Button 
                  variant="normal" 
                  onClick={() => {
                    setFiles([]);
                    setStudies(new Map());
                    setRejectedCount(0);
                  }}
                  disabled={uploading}
                >
                  Clear All
                </Button>
              </Box>
              <Table
                columnDefinitions={[
                  {
                    id: 'checkbox',
                    header: (
                      <Checkbox
                        checked={selectedSeriesUIDs.size > 0 && (() => {
                          let totalSeries = 0;
                          studies.forEach(study => {
                            totalSeries += study.series.size;
                          });
                          return selectedSeriesUIDs.size === totalSeries;
                        })()}
                        indeterminate={selectedSeriesUIDs.size > 0 && (() => {
                          let totalSeries = 0;
                          studies.forEach(study => {
                            totalSeries += study.series.size;
                          });
                          return selectedSeriesUIDs.size < totalSeries;
                        })()}
                        onChange={({ detail }) => {
                          if (uploading || uploadComplete) return;
                          if (detail.checked) {
                            // Select all series
                            const allSeriesUIDs = new Set<string>();
                            studies.forEach(study => {
                              study.series.forEach(series => {
                                allSeriesUIDs.add(series.seriesInstanceUID);
                              });
                            });
                            setSelectedSeriesUIDs(allSeriesUIDs);
                          } else {
                            // Deselect all
                            setSelectedSeriesUIDs(new Set());
                          }
                        }}
                        disabled={uploading || uploadComplete}
                      />
                    ),
                    cell: (item: any) => {
                      if (item._type === 'study') {
                        const studySeriesUIDs = Array.from(item.series.keys()) as string[];
                        const allSelected = studySeriesUIDs.every(uid => selectedSeriesUIDs.has(uid));
                        const someSelected = studySeriesUIDs.some(uid => selectedSeriesUIDs.has(uid));
                        
                        return (
                          <Checkbox
                            checked={allSelected}
                            indeterminate={someSelected && !allSelected}
                            onChange={({ detail }) => {
                              if (uploading || uploadComplete) return;
                              const newSelected = new Set(selectedSeriesUIDs);
                              if (detail.checked) {
                                // Add all series from this study
                                item.series.forEach((series: DicomSeries) => {
                                  newSelected.add(series.seriesInstanceUID);
                                });
                              } else {
                                // Remove all series from this study
                                item.series.forEach((series: DicomSeries) => {
                                  newSelected.delete(series.seriesInstanceUID);
                                });
                              }
                              setSelectedSeriesUIDs(newSelected);
                            }}
                            disabled={uploading || uploadComplete}
                          />
                        );
                      } else {
                        // Series row
                        return (
                          <Box margin={{ left: 'l' }}>
                            <Checkbox
                              checked={selectedSeriesUIDs.has(item.seriesInstanceUID)}
                              onChange={({ detail }) => {
                                if (uploading || uploadComplete) return;
                                const newSelected = new Set(selectedSeriesUIDs);
                                if (detail.checked) {
                                  newSelected.add(item.seriesInstanceUID);
                                } else {
                                  newSelected.delete(item.seriesInstanceUID);
                                }
                                setSelectedSeriesUIDs(newSelected);
                              }}
                              disabled={uploading || uploadComplete}
                            />
                          </Box>
                        );
                      }
                    },
                    width: 50
                  },
                  {
                    id: 'patientID',
                    header: 'Patient ID',
                    cell: (item: any) => {
                      if (item._type === 'study') return item.patientID || '-';
                      return <Box margin={{ left: 'l' }}>Series #{item.seriesNumber || '-'}</Box>;
                    },
                    width: 150
                  },
                  {
                    id: 'patientName',
                    header: 'Patient Name',
                    cell: (item: any) => {
                      if (item._type === 'study') return item.patientName || '-';
                      return '';
                    },
                    width: 200
                  },
                  {
                    id: 'studyDate',
                    header: 'Study Date',
                    cell: (item: any) => {
                      if (item._type === 'study') return item.studyDate || '-';
                      return '';
                    },
                    width: 100
                  },
                  {
                    id: 'studyDescription',
                    header: 'Study Description',
                    cell: (item: any) => {
                      if (item._type === 'study') return item.studyDescription || '-';
                      return <Box margin={{ left: 'l' }}>{item.seriesDescription || '-'}</Box>;
                    }
                  },
                  {
                    id: 'modalities',
                    header: 'Modalities',
                    cell: (item: any) => {
                      if (item._type === 'study') return getStudyModalities(item) || '-';
                      return <Box margin={{ left: 'l' }}>{item.modality || '-'}</Box>;
                    },
                    width: 120
                  },
                  {
                    id: 'accessionNumber',
                    header: 'Accession #',
                    cell: (item: any) => {
                      if (item._type === 'study') return item.accessionNumber || '-';
                      return '';
                    },
                    width: 120
                  },
                  {
                    id: 'instanceCount',
                    header: 'Instances',
                    cell: (item: any) => {
                      if (item._type === 'study') return getStudyInstanceCount(item).toString();
                      return item.instances.length.toString();
                    },
                    width: 80
                  },
                  {
                    id: 'status',
                    header: 'Status',
                    cell: (item: any) => {
                      if (item._type === 'study') return renderStatusIcon(getStudyStatus(item));
                      return renderStatusIcon(item.status);
                    },
                    width: 100
                  }
                ]}
                items={Array.from(studies.values())}
                expandableRows={{
                  getItemChildren: (item: any) => {
                    if (item._type === 'study' && item.series instanceof Map) {
                      return Array.from(item.series.values());
                    }
                    return [];
                  },
                  isItemExpandable: (item: any) => item._type === 'study' && item.series instanceof Map && item.series.size > 0,
                  expandedItems: Array.from(studies.values()).filter(s => s.expanded),
                  onExpandableItemToggle: ({ detail }) => {
                    const item = detail.item as any;
                    if ('studyInstanceUID' in item) {
                      toggleStudyExpanded(item.studyInstanceUID);
                    }
                  }
                }}
                variant="embedded"
                empty={
                  <Box textAlign="center" color="inherit">
                    <b>No studies found</b>
                  </Box>
                }
              />
            </SpaceBetween>
          </Container>
        )}

        {uploading && (
          <Container>
            <ProgressBar
              value={(getOverallProgress().completedInstances / getOverallProgress().totalInstances) * 100}
              label="Overall Upload Progress"
              description={`${getOverallProgress().completedInstances} of ${getOverallProgress().totalInstances} instances uploaded`}
              status={getOverallProgress().failedInstances > 0 ? 'error' : 'in-progress'}
            />
          </Container>
        )}
      </SpaceBetween>
    </Modal>
  );
};

export default FileUploader;
