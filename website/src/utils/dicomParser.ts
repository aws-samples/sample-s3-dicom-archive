import dicomParser from 'dicom-parser';

export interface DicomInstance {
  file: File;
  fileName: string;
  sopInstanceUID: string;
}

export interface DicomSeries {
  seriesInstanceUID: string;
  seriesNumber: string;
  seriesDescription: string;
  modality: string;
  instances: DicomInstance[];
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  _type: 'series';
}

export interface DicomStudy {
  studyInstanceUID: string;
  patientID: string;
  patientName: string;
  studyDate: string;
  studyDescription: string;
  accessionNumber: string;
  series: Map<string, DicomSeries>;
  expanded: boolean;
  _type: 'study';
}

export interface ParsedDicomData {
  studies: Map<string, DicomStudy>;
  rejectedCount: number;
}

async function isDicomFile(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target?.result as ArrayBuffer;
      if (!buffer || buffer.byteLength < 132) {
        resolve(false);
        return;
      }
      
      const view = new Uint8Array(buffer);
      // Check for 128 null bytes followed by 'DICM'
      const isDicm = view[128] === 68 && view[129] === 73 && view[130] === 67 && view[131] === 77;
      resolve(isDicm);
    };
    reader.onerror = () => resolve(false);
    reader.readAsArrayBuffer(file.slice(0, 132));
  });
}

async function parseDicomFile(file: File): Promise<{
  studyInstanceUID: string;
  patientID: string;
  patientName: string;
  studyDate: string;
  studyDescription: string;
  accessionNumber: string;
  seriesInstanceUID: string;
  seriesNumber: string;
  seriesDescription: string;
  modality: string;
  sopInstanceUID: string;
} | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const byteArray = new Uint8Array(arrayBuffer);
        const dataSet = dicomParser.parseDicom(byteArray);

        const getString = (tag: string) => {
          try {
            return dataSet.string(tag)?.trim() || '';
          } catch {
            return '';
          }
        };

        resolve({
          studyInstanceUID: getString('x0020000d'),
          patientID: getString('x00100020'),
          patientName: getString('x00100010'),
          studyDate: getString('x00080020'),
          studyDescription: getString('x00081030'),
          accessionNumber: getString('x00080050'),
          seriesInstanceUID: getString('x0020000e'),
          seriesNumber: getString('x00200011'),
          seriesDescription: getString('x0008103e'),
          modality: getString('x00080060'),
          sopInstanceUID: getString('x00080018')
        });
      } catch (error) {
        console.error('Error parsing DICOM file:', file.name, error.message);
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file);
  });
}

export async function parseDicomFiles(files: File[]): Promise<ParsedDicomData> {
  const studies = new Map<string, DicomStudy>();
  let rejectedCount = 0;

  for (const file of files) {
    // Check DICOM preamble
    const isDicom = await isDicomFile(file);
    if (!isDicom) {
      rejectedCount++;
      continue;
    }

    // Parse DICOM metadata
    const metadata = await parseDicomFile(file);
    if (!metadata || !metadata.studyInstanceUID || !metadata.seriesInstanceUID) {
      rejectedCount++;
      continue;
    }

    // Get or create study
    let study = studies.get(metadata.studyInstanceUID);
    if (!study) {
      study = {
        studyInstanceUID: metadata.studyInstanceUID,
        patientID: metadata.patientID,
        patientName: metadata.patientName,
        studyDate: metadata.studyDate,
        studyDescription: metadata.studyDescription,
        accessionNumber: metadata.accessionNumber,
        series: new Map(),
        expanded: false,
        _type: 'study'
      };
      studies.set(metadata.studyInstanceUID, study);
    }

    // Get or create series
    let series = study.series.get(metadata.seriesInstanceUID);
    if (!series) {
      series = {
        seriesInstanceUID: metadata.seriesInstanceUID,
        seriesNumber: metadata.seriesNumber,
        seriesDescription: metadata.seriesDescription,
        modality: metadata.modality,
        instances: [],
        status: 'pending',
        _type: 'series'
      };
      study.series.set(metadata.seriesInstanceUID, series);
    }

    // Add instance
    series.instances.push({
      file,
      fileName: file.name,
      sopInstanceUID: metadata.sopInstanceUID
    });
  }

  return { studies, rejectedCount };
}
