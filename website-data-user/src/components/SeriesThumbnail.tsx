import React, { useState, useEffect, useRef } from 'react';
import { Icon } from '@cloudscape-design/components';
import { dicomwebService } from '../services/dicomwebService';
import { processRawPixelData, dicomToDataUrl } from '../utils/dicomImageProcessor';

interface SeriesThumbnailProps {
  datastoreId: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
}

const SeriesThumbnail: React.FC<SeriesThumbnailProps> = ({
  datastoreId, studyInstanceUID, seriesInstanceUID
}) => {
  const [imageSrc, setImageSrc] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(false);

        // Get first instance of the series
        const instances = await dicomwebService.searchInstances(
          datastoreId, studyInstanceUID, seriesInstanceUID
        );
        if (cancelled || !instances.length) { setError(true); return; }
        const sopUID = instances[0].sopInstanceUID;

        // Get pixel metadata via WADO-RS
        const meta = await dicomwebService.getInstanceWadoMetadata(
          datastoreId, studyInstanceUID, seriesInstanceUID, sopUID
        );
        if (cancelled || !meta) { setError(true); return; }

        const { rows: height, columns: width, bitsAllocated, samplesPerPixel,
          planarConfiguration, transferSyntaxUID, windowCenter, windowWidth } = meta;

        // Determine effective photometric interpretation
        const isUncompressed = !transferSyntaxUID || transferSyntaxUID === '1.2.840.10008.1.2'
          || transferSyntaxUID === '1.2.840.10008.1.2.1' || transferSyntaxUID === '1.2.840.10008.1.2.2';
        const photometricInterpretation = (!isUncompressed && samplesPerPixel === 3)
          ? 'RGB' : (meta.photometricInterpretation || 'MONOCHROME2');

        // Get frame data
        const frame = await dicomwebService.getFrame(
          datastoreId, studyInstanceUID, seriesInstanceUID, sopUID
        );
        if (cancelled || !frame) { setError(true); return; }

        if (frame.isRaw) {
          const imageData = processRawPixelData(
            frame.data, width, height, bitsAllocated,
            windowCenter, windowWidth,
            photometricInterpretation, samplesPerPixel, planarConfiguration
          );
          if (!imageData) { setError(true); return; }
          const dataUrl = await dicomToDataUrl(imageData, 64);
          if (cancelled) return;
          if (dataUrl) { setImageSrc(dataUrl); }
          else { setError(true); }
        } else {
          const blob = new Blob([frame.data], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          if (!cancelled) setImageSrc(url);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
    };
  }, [datastoreId, studyInstanceUID, seriesInstanceUID]);

  if (loading) return <Icon name="status-in-progress" size="normal" />;
  if (error || !imageSrc) return <span style={{ color: '#999', fontSize: '11px' }}>N/A</span>;
  return (
    <img src={imageSrc} alt="Thumbnail"
      style={{ width: '32px', height: '32px', objectFit: 'cover', borderRadius: '3px', border: '1px solid #ccc' }}
    />
  );
};

export default SeriesThumbnail;
