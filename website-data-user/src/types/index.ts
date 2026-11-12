export type SourceType = 'datastore' | 'virtualFolder';

export interface DataSource {
  id: string;
  name: string;
  type: SourceType;
  datastoreArn?: string;
}

export interface Tab {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  datastoreArn?: string;
}

export interface Study {
  studyInstanceUID: string;
  patientID?: string;
  patientName?: string;
  studyDate?: string;
  studyDescription?: string;
  modality?: string;
  accessionNumber?: string;
  seriesCount?: number;
  instanceCount?: number;
}

export interface Series {
  seriesInstanceUID: string;
  studyInstanceUID: string;
  seriesNumber?: string;
  seriesDescription?: string;
  modality?: string;
  instanceCount?: number;
}

export interface Instance {
  sopInstanceUID: string;
  seriesInstanceUID: string;
  studyInstanceUID: string;
  instanceNumber?: string;
  sopClassUID?: string;
}
