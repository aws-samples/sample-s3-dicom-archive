// Virtual Folder Types

export interface DicomTag {
  tag: string;
  name: string;
  vr: string;
  level: 'PATIENT' | 'STUDY' | 'SERIES' | 'INSTANCE';
  required?: boolean;
  computed?: boolean;
  maxLength?: number;
  isUid?: boolean;
}

export interface DicomTagsReference {
  tags: Record<string, DicomTag>;
  actions: Record<string, string>;
  requiredByLevel: {
    PATIENT: DicomTag[];
    STUDY: DicomTag[];
    SERIES: DicomTag[];
    INSTANCE: DicomTag[];
  };
}

export type TableType = 'PATIENT' | 'STUDY' | 'SERIES' | 'INSTANCE';

export interface TagMapping {
  tag: string;
  table: TableType;
}

export interface IndexingProfile {
  id: string;
  name: string;
  description?: string;
  patient_attributes: string[];
  study_attributes: string[];
  series_attributes: string[];
  instance_attributes: string[];
  created_at: string;
  updated_at: string;
  created_by: string;
  current_version: number;
  deleted: boolean;
}

export type DeidAction = 'REMOVE' | 'HASH' | 'HASH_8' | 'HASH_16' | 'HASH_32' | 'KEEP' | 'REPLACE' | 'SHIFT_DATE' | 'EMPTY';

export interface TagAction {
  tag: string;
  action: DeidAction;
  replacement?: string;
  shiftDaysMin?: number;
  shiftDaysMax?: number;
}

export interface DeidProfile {
  id: string;
  name: string;
  description?: string;
  tag_actions: TagAction[];
  drop_private_tags: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
  current_version: number;
  deleted: boolean;
}

export interface VirtualFolder {
  id: string;
  name: string;
  description?: string;
  status: 'ACTIVE' | 'DISABLED' | 'DELETING';
  indexing_profile_id?: string;
  deid_profile_id?: string;
  write_mode?: 'NONE' | 'EXISTING' | 'DEDICATED';
  write_datastore_id?: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  deleted: boolean;
}
