import React, { useState, useEffect, useRef } from 'react';
import { Icon, Box, Modal } from '@cloudscape-design/components';
import dicomwebService from '../services/dicomwebService';
import { processRawPixelData, dicomToDataUrl } from '../utils/dicomImageProcessor';

interface DicomThumbnailProps {
  datastoreId: string;
  internalDatastoreId?: string;
  /**
   * S3-only build: retained as an optional passthrough to the DICOMweb service.
   * Typed loosely so it survives the shared types dropping storageType.
   */
  storageType?: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUID: string;
  theme?: 'light' | 'dark';
}

const DicomThumbnail: React.FC<DicomThumbnailProps> = ({
  datastoreId, internalDatastoreId, storageType, studyInstanceUID, seriesInstanceUID, sopInstanceUID, theme = 'light'
}) => {
  const [imageSrc, setImageSrc] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [fullSizeImageSrc, setFullSizeImageSrc] = useState<string>('');
  const [fullSizeLoading, setFullSizeLoading] = useState(false);
  const blobUrlRef = useRef<string | null>(null);
  const fullSizeBlobUrlRef = useRef<string | null>(null);

  // Revoke any blob URL held for the full-size image; the data URL path needs no cleanup.
  const releaseFullSizeBlob = () => {
    if (fullSizeBlobUrlRef.current) {
      URL.revokeObjectURL(fullSizeBlobUrlRef.current);
      fullSizeBlobUrlRef.current = null;
    }
  };

  useEffect(() => releaseFullSizeBlob, []);

  useEffect(() => {
    const loadThumbnail = async () => {
      try {
        setLoading(true);
        setError(false);

        // Use WADO-RS metadata to get pixel-level attributes
        const metadataResponse = await dicomwebService.getInstanceWadoMetadata(
          datastoreId, studyInstanceUID, seriesInstanceUID, sopInstanceUID, internalDatastoreId, storageType
        );

        if (!metadataResponse.success || !metadataResponse.data) {
          throw new Error('Failed to fetch instance metadata');
        }

        const metadata = metadataResponse.data;
        const width = metadata.columns || 512;
        const height = metadata.rows || 512;
        const bitsAllocated = metadata.bitsAllocated || 16;
        const windowCenter = metadata.windowCenter;
        const windowWidth = metadata.windowWidth;
        const samplesPerPixel = metadata.samplesPerPixel || 1;
        const planarConfiguration = metadata.planarConfiguration || 0;
        const transferSyntaxUID = metadata.transferSyntaxUID || '';

        // For compressed transfer syntaxes (JPEG, JPEG2000, etc.), the backend decompresses
        // the frame and returns RGB pixel data regardless of the stored photometric interpretation
        // (the S3 container does so via pydicom's pixel_array).
        // Only use the original photometric interpretation for uncompressed transfer syntaxes.
        const isUncompressed = !transferSyntaxUID || transferSyntaxUID === '1.2.840.10008.1.2'
          || transferSyntaxUID === '1.2.840.10008.1.2.1' || transferSyntaxUID === '1.2.840.10008.1.2.2';
        const photometricInterpretation = (!isUncompressed && samplesPerPixel === 3)
          ? 'RGB'
          : (metadata.photometricInterpretation || 'MONOCHROME2');

        console.log('🖼️ Image parameters from WADO-RS metadata:', {
          width, height, bitsAllocated, windowCenter, windowWidth,
          photometricInterpretation, samplesPerPixel, planarConfiguration
        });

        const frameResponse = await dicomwebService.getFrame(
          datastoreId, studyInstanceUID, seriesInstanceUID, sopInstanceUID, 1, internalDatastoreId, storageType
        );

        if (frameResponse.success && frameResponse.data) {
          if (frameResponse.metadata?.isRawPixelData) {
            // Diagnostic: dump first pixel triplets to determine actual color space
            if (samplesPerPixel === 3) {
              const diag = new Uint8Array(frameResponse.data);
              const mid = Math.floor((width * height * 3) / 2);
              console.log('🔬 Frame diagnostic — first 5 pixel triplets:', 
                Array.from({length: 5}, (_, i) => `[${diag[i*3]}, ${diag[i*3+1]}, ${diag[i*3+2]}]`).join(' '));
              console.log('🔬 Frame diagnostic — mid 5 pixel triplets:', 
                Array.from({length: 5}, (_, i) => `[${diag[mid+i*3]}, ${diag[mid+i*3+1]}, ${diag[mid+i*3+2]}]`).join(' '));
              console.log('🔬 If white=[255,255,255] → RGB. If white=[235,128,128] → YBR_FULL. Transfer syntax:', transferSyntaxUID);
            }
            const imageData = processRawPixelData(
              frameResponse.data, width, height, bitsAllocated,
              windowCenter, windowWidth,
              photometricInterpretation, samplesPerPixel, planarConfiguration
            );

            if (imageData) {
              const dataUrl = await dicomToDataUrl(imageData, 64);
              if (dataUrl) {
                setImageSrc(dataUrl);
                console.log('✅ Successfully created DICOM JPEG thumbnail from raw pixel data');
              } else { setError(true); }
            } else { setError(true); }
          } else {
            const blob = new Blob([frameResponse.data], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            blobUrlRef.current = url;
            setImageSrc(url);
          }
        } else { setError(true); }
      } catch (err) {
        console.error('❌ Failed to load thumbnail:', { errorType: err.name });
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    loadThumbnail();
    return () => {
      if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
    };
  }, [datastoreId, storageType, studyInstanceUID, seriesInstanceUID, sopInstanceUID]);

  const handleThumbnailClick = async () => {
    if (error || loading) return;
    setShowModal(true);
    setFullSizeLoading(true);

    try {
      const metadataResponse = await dicomwebService.getInstanceWadoMetadata(
        datastoreId, studyInstanceUID, seriesInstanceUID, sopInstanceUID, internalDatastoreId, storageType
      );

      if (!metadataResponse.success || !metadataResponse.data) {
        throw new Error('Failed to fetch instance metadata for full-size image');
      }

      const metadata = metadataResponse.data;
      const width = metadata.columns || 512;
      const height = metadata.rows || 512;
      const bitsAllocated = metadata.bitsAllocated || 16;
      const windowCenter = metadata.windowCenter;
      const windowWidth = metadata.windowWidth;
      const samplesPerPixel = metadata.samplesPerPixel || 1;
      const planarConfiguration = metadata.planarConfiguration || 0;
      const transferSyntaxUID = metadata.transferSyntaxUID || '';
      const isUncompressed = !transferSyntaxUID || transferSyntaxUID === '1.2.840.10008.1.2'
        || transferSyntaxUID === '1.2.840.10008.1.2.1' || transferSyntaxUID === '1.2.840.10008.1.2.2';
      const photometricInterpretation = (!isUncompressed && samplesPerPixel === 3)
        ? 'RGB'
        : (metadata.photometricInterpretation || 'MONOCHROME2');

      const frameResponse = await dicomwebService.getFrame(
        datastoreId, studyInstanceUID, seriesInstanceUID, sopInstanceUID, 1, internalDatastoreId, storageType
      );

      if (!frameResponse.success || !frameResponse.data) {
        throw new Error('Failed to fetch frame for full-size image');
      }

      if (frameResponse.metadata?.isRawPixelData) {
        const imageData = processRawPixelData(
          frameResponse.data, width, height, bitsAllocated,
          windowCenter, windowWidth,
          photometricInterpretation, samplesPerPixel, planarConfiguration
        );

        if (imageData) {
          const maxSize = Math.min(1024, Math.max(width, height));
          const dataUrl = await dicomToDataUrl(imageData, maxSize);
          if (dataUrl) { setFullSizeImageSrc(dataUrl); }
          else { throw new Error('Failed to create full-size image'); }
        } else { throw new Error('Failed to process full-size pixel data'); }
      } else {
        // A lossy-stored frame comes back still encoded (the backend will not re-encode it),
        // so hand it to the browser's own decoder like the thumbnail path does.
        const blob = new Blob([frameResponse.data], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        releaseFullSizeBlob();
        fullSizeBlobUrlRef.current = url;
        setFullSizeImageSrc(url);
      }
    } catch (err) {
      console.error('❌ Failed to load full-size image:', { errorType: err.name });
    } finally {
      setFullSizeLoading(false);
    }
  };

  return (
    <>
      <div
        onClick={handleThumbnailClick}
        style={{ cursor: (loading || error) ? 'default' : 'pointer', display: 'inline-block' }}
      >
        {loading ? (
          <div style={{ width: '64px', height: '64px', backgroundColor: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="status-in-progress" size="medium" />
          </div>
        ) : error || !imageSrc ? (
          <div style={{ width: '32px', height: '32px', backgroundColor: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="16" cy="16" r="15" stroke={theme === 'dark' ? '#9ba7b6' : '#999'} strokeWidth="2" fill="transparent"/>
              <text x="16" y="20" textAnchor="middle" fontSize="10" fontFamily="Arial, sans-serif" fill={theme === 'dark' ? '#9ba7b6' : '#666'}>N/A</text>
            </svg>
          </div>
        ) : (
          <img
            src={imageSrc}
            alt="Series thumbnail"
            style={{
              width: '32px', height: '32px', objectFit: 'cover',
              border: theme === 'dark' ? '1px solid #9ba7b6' : '1px solid #999',
              borderRadius: '4px',
              backgroundColor: theme === 'dark' ? '#2a3441' : '#f5f5f5',
              transition: 'transform 0.2s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.05)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
          />
        )}
      </div>

      <Modal
        onDismiss={() => { setShowModal(false); setFullSizeImageSrc(''); releaseFullSizeBlob(); }}
        visible={showModal}
        size="max"
        header="DICOM Image Viewer"
      >
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px', maxHeight: '80vh', overflow: 'auto' }}>
          {fullSizeLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
              <Icon name="status-in-progress" size="large" />
              <div>Loading full-size image...</div>
            </div>
          ) : fullSizeImageSrc ? (
            <img
              src={fullSizeImageSrc}
              alt="Full-size DICOM"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', border: '1px solid #ddd', borderRadius: '4px' }}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', color: '#666' }}>
              <Icon name="status-warning" size="large" />
              <div>Failed to load full-size image</div>
            </div>
          )}
        </div>
        {fullSizeImageSrc && (
          <Box margin={{ top: 'm' }}>
            <div style={{ fontSize: '12px', color: '#666' }}>
              <strong>Study:</strong> {studyInstanceUID}<br/>
              <strong>Series:</strong> {seriesInstanceUID}<br/>
              <strong>Instance:</strong> {sopInstanceUID}
            </div>
          </Box>
        )}
      </Modal>
    </>
  );
};

export default DicomThumbnail;
