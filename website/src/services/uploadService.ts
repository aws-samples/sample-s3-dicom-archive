import { apiClient } from './apiClient';

export interface UploadFile {
  path: string;
  name: string;
  size: number;
  type: string;
  file: File;
}

export interface UploadProgress {
  file: string;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  error?: string;
  attempt?: number;
}

class UploadService {
  async generateUploadUrlsForSeries(
    seriesFiles: Array<{ file: File; clientId: string; studyInstanceUID: string; seriesInstanceUID: string; sopInstanceUID: string; studyDate?: string }>,
    datastoreId: string
  ): Promise<{
    uploadUrls: Array<{ file: string; url: string; key: string; bucket?: string; method: string }>;
    bucketName: string;
    failed?: Array<{ file: string; reason: string }>;
  }> {
    // DICOM import: the API presigns DIRECTLY into the datastore's archive bucket
    // at the DICOM-partition key (YYYY/MM/DD/study/series/sop.dcm, or
    // study/series/sop.dcm when StudyDate is absent). The archive bucket's S3
    // events drive s3-ingest, so no staging bucket and no import job are needed.
    const response = await apiClient.makeRequest('/import-jobs/upload-url', {
      method: 'POST',
      body: JSON.stringify({
        datastoreId,
        files: seriesFiles.map(sf => ({
          clientId: sf.clientId,
          name: sf.file.name,
          size: sf.file.size,
          studyInstanceUID: sf.studyInstanceUID,
          seriesInstanceUID: sf.seriesInstanceUID,
          sopInstanceUID: sf.sopInstanceUID,
          studyDate: sf.studyDate || ''
        }))
      })
    });

    if (!response.success) {
      throw new Error(response.message || 'Failed to generate upload URLs');
    }

    return response.data as {
      uploadUrls: Array<{ file: string; url: string; key: string; bucket?: string; method: string }>;
      bucketName: string;
      failed?: Array<{ file: string; reason: string }>;
    };
  }

  async uploadFilesForSeries(
    seriesFiles: Array<{ file: File; clientId: string }>,
    uploadUrls: Array<{ file: string; url: string; key: string; method: string }>,
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void
  ): Promise<void> {
    const concurrency = 5;
    const chunks: typeof seriesFiles[] = [];
    for (let i = 0; i < seriesFiles.length; i += concurrency) {
      chunks.push(seriesFiles.slice(i, i + concurrency));
    }

    let completedCount = 0;
    const totalCount = seriesFiles.length;

    for (const chunk of chunks) {
      if (signal?.aborted) {
        throw new Error('Upload cancelled');
      }

      await Promise.all(
        chunk.map(async (sf) => {
          const urlInfo = uploadUrls.find(u => u.file === sf.clientId);
          if (!urlInfo) {
            throw new Error(`No upload URL found for ${sf.clientId}`);
          }

          await this.uploadFileWithRetry(sf.file, urlInfo.url, 3);
          completedCount++;
          if (onProgress) onProgress(completedCount, totalCount);
        })
      );
    }
  }

  async uploadFile(
    file: File,
    url: string,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          const progress = (e.loaded / e.total) * 100;
          onProgress(progress);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Upload failed'));
      });

      xhr.addEventListener('abort', () => {
        reject(new Error('Upload aborted'));
      });

      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.send(file);
    });
  }

  async uploadFileWithRetry(
    file: File,
    url: string,
    maxAttempts: number = 3,
    onProgress?: (progress: number) => void,
    onAttempt?: (attempt: number) => void
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (onAttempt) onAttempt(attempt);
        await this.uploadFile(file, url, onProgress);
        return;
      } catch (error) {
        lastError = error as Error;
        console.error(`Upload attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxAttempts) {
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }

    throw lastError || new Error('Upload failed after all attempts');
  }

  async uploadFiles(
    files: UploadFile[],
    uploadUrls: any[],
    onProgress?: (fileProgress: Map<string, UploadProgress>) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const progressMap = new Map<string, UploadProgress>();

    // Initialize progress for all files
    files.forEach(f => {
      progressMap.set(f.path, {
        file: f.path,
        progress: 0,
        status: 'pending'
      });
    });

    if (onProgress) onProgress(new Map(progressMap));

    // Upload files in parallel (max 5 concurrent)
    const concurrency = 5;
    const chunks: UploadFile[][] = [];
    for (let i = 0; i < files.length; i += concurrency) {
      chunks.push(files.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      if (signal?.aborted) {
        throw new Error('Upload cancelled');
      }

      await Promise.all(
        chunk.map(async (file) => {
          const urlInfo = uploadUrls.find(u => u.file === file.path);
          if (!urlInfo) {
            progressMap.set(file.path, {
              file: file.path,
              progress: 0,
              status: 'failed',
              error: 'No upload URL found'
            });
            if (onProgress) onProgress(new Map(progressMap));
            return;
          }

          try {
            progressMap.set(file.path, {
              file: file.path,
              progress: 0,
              status: 'uploading',
              attempt: 1
            });
            if (onProgress) onProgress(new Map(progressMap));

            await this.uploadFileWithRetry(
              file.file,
              urlInfo.url,
              3,
              (progress) => {
                progressMap.set(file.path, {
                  file: file.path,
                  progress,
                  status: 'uploading'
                });
                if (onProgress) onProgress(new Map(progressMap));
              },
              (attempt) => {
                progressMap.set(file.path, {
                  file: file.path,
                  progress: 0,
                  status: 'uploading',
                  attempt
                });
                if (onProgress) onProgress(new Map(progressMap));
              }
            );

            progressMap.set(file.path, {
              file: file.path,
              progress: 100,
              status: 'completed'
            });
            if (onProgress) onProgress(new Map(progressMap));
          } catch (error) {
            progressMap.set(file.path, {
              file: file.path,
              progress: 0,
              status: 'failed',
              error: (error as Error).message
            });
            if (onProgress) onProgress(new Map(progressMap));
            throw error;
          }
        })
      );
    }
  }
}

export const uploadService = new UploadService();
export default uploadService;
