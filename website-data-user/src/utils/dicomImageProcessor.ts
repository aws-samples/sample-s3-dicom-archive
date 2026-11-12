/**
 * DICOM Image Processing Utility
 * Converts raw DICOM pixel data to JPEG images for efficient thumbnail display.
 * Supports MONOCHROME1, MONOCHROME2, RGB, YBR_FULL, and YBR_FULL_422.
 */

export interface DicomImageData {
  width: number;
  height: number;
  pixelData: Uint16Array | Uint8Array;
  windowCenter?: number;
  windowWidth?: number;
  rescaleIntercept?: number;
  rescaleSlope?: number;
  photometricInterpretation?: string;
  bitsAllocated?: number;
  bitsStored?: number;
  samplesPerPixel?: number;
  planarConfiguration?: number;
}

/**
 * Process raw pixel data from the S3-backed DICOMweb API
 */
export function processRawPixelData(
  rawPixelData: ArrayBuffer,
  width: number,
  height: number,
  bitsAllocated: number = 16,
  windowCenter?: number,
  windowWidth?: number,
  photometricInterpretation: string = 'MONOCHROME2',
  samplesPerPixel: number = 1,
  planarConfiguration: number = 0
): DicomImageData | null {
  try {
    if (!width || !height) {
      throw new Error('Image dimensions are required for raw pixel data processing');
    }

    const pixelData = bitsAllocated === 16
      ? new Uint16Array(rawPixelData)
      : new Uint8Array(rawPixelData);

    console.log('📊 Processing raw DICOM pixel data:', {
      width, height, bitsAllocated, photometricInterpretation, samplesPerPixel, planarConfiguration,
      expectedSamples: width * height * samplesPerPixel, actualSamples: pixelData.length
    });

    return {
      width, height, pixelData, windowCenter, windowWidth,
      rescaleIntercept: 0, rescaleSlope: 1,
      photometricInterpretation, bitsAllocated, bitsStored: bitsAllocated,
      samplesPerPixel, planarConfiguration,
    };
  } catch (error) {
    console.error('❌ Error processing raw pixel data:', error.message);
    return null;
  }
}

/**
 * Apply windowing to monochrome pixel data, returning 8-bit grayscale values.
 */
function applyWindowingToPixelData(
  pixelData: Uint16Array | Uint8Array,
  width: number,
  height: number,
  windowCenter?: number,
  windowWidth?: number,
  rescaleIntercept: number = 0,
  rescaleSlope: number = 1,
  invert: boolean = false
): Uint8ClampedArray {
  let wc = windowCenter || 0;
  let ww = windowWidth || 0;

  if (ww === 0) {
    let minVal = pixelData[0];
    let maxVal = pixelData[0];
    for (let i = 1; i < pixelData.length; i++) {
      if (pixelData[i] < minVal) minVal = pixelData[i];
      if (pixelData[i] > maxVal) maxVal = pixelData[i];
    }
    wc = (maxVal + minVal) / 2;
    ww = maxVal - minVal;
  }

  const wwHalf = ww / 2;
  const wcMin = wc - wwHalf;
  const wcMax = wc + wwHalf;
  const pixelCount = width * height;
  const outputData = new Uint8ClampedArray(pixelCount);

  for (let i = 0; i < pixelData.length && i < pixelCount; i++) {
    const pixelValue = pixelData[i] * rescaleSlope + rescaleIntercept;
    let displayValue: number;
    if (pixelValue <= wcMin) {
      displayValue = 0;
    } else if (pixelValue >= wcMax) {
      displayValue = 255;
    } else {
      displayValue = Math.round(((pixelValue - wcMin) / ww) * 255);
    }
    if (invert) displayValue = 255 - displayValue;
    outputData[i] = displayValue;
  }

  return outputData;
}

/** Clamp a value to 0-255 */
function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Extract interleaved RGB data from pixel data.
 * Handles RGB (planar 0 and 1), YBR_FULL, and YBR_FULL_422.
 */
function extractColorData(
  pixelData: Uint16Array | Uint8Array,
  width: number,
  height: number,
  photometricInterpretation: string,
  planarConfiguration: number
): Uint8ClampedArray {
  const pixelCount = width * height;
  const rgb = new Uint8ClampedArray(pixelCount * 3);

  if (photometricInterpretation === 'RGB') {
    if (planarConfiguration === 1) {
      // Planar: RRRR...GGGG...BBBB...
      for (let i = 0; i < pixelCount; i++) {
        rgb[i * 3] = pixelData[i];
        rgb[i * 3 + 1] = pixelData[pixelCount + i];
        rgb[i * 3 + 2] = pixelData[pixelCount * 2 + i];
      }
    } else {
      // Interleaved: RGBRGBRGB...
      for (let i = 0; i < pixelCount; i++) {
        rgb[i * 3] = pixelData[i * 3];
        rgb[i * 3 + 1] = pixelData[i * 3 + 1];
        rgb[i * 3 + 2] = pixelData[i * 3 + 2];
      }
    }
  } else if (photometricInterpretation === 'YBR_FULL') {
    for (let i = 0; i < pixelCount; i++) {
      const y = pixelData[i * 3];
      const cb = pixelData[i * 3 + 1];
      const cr = pixelData[i * 3 + 2];
      rgb[i * 3] = clamp(y + 1.402 * (cr - 128));
      rgb[i * 3 + 1] = clamp(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
      rgb[i * 3 + 2] = clamp(y + 1.772 * (cb - 128));
    }
  } else if (photometricInterpretation === 'YBR_FULL_422') {
    // Subsampled: [Y0, Y1, Cb, Cr] per 2-pixel group
    for (let i = 0; i < pixelCount; i += 2) {
      const base = i * 2;
      const y0 = pixelData[base];
      const y1 = pixelData[base + 1];
      const cb = pixelData[base + 2];
      const cr = pixelData[base + 3];
      rgb[i * 3] = clamp(y0 + 1.402 * (cr - 128));
      rgb[i * 3 + 1] = clamp(y0 - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
      rgb[i * 3 + 2] = clamp(y0 + 1.772 * (cb - 128));
      if (i + 1 < pixelCount) {
        rgb[(i + 1) * 3] = clamp(y1 + 1.402 * (cr - 128));
        rgb[(i + 1) * 3 + 1] = clamp(y1 - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
        rgb[(i + 1) * 3 + 2] = clamp(y1 + 1.772 * (cb - 128));
      }
    }
  }

  return rgb;
}

/**
 * Create a thumbnail-sized version of grayscale (1-channel) image data.
 */
function createGrayscaleThumbnail(
  imageData: Uint8ClampedArray,
  originalWidth: number,
  originalHeight: number,
  maxSize: number = 64
): { data: Uint8ClampedArray; width: number; height: number } {
  const aspectRatio = originalWidth / originalHeight;
  let tw = maxSize, th = maxSize;
  if (aspectRatio > 1) { th = Math.round(maxSize / aspectRatio); }
  else { tw = Math.round(maxSize * aspectRatio); }

  const out = new Uint8ClampedArray(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const srcX = Math.floor((x / tw) * originalWidth);
      const srcY = Math.floor((y / th) * originalHeight);
      out[y * tw + x] = imageData[srcY * originalWidth + srcX] || 0;
    }
  }
  return { data: out, width: tw, height: th };
}

/**
 * Create a thumbnail-sized version of color (3-channel RGB) image data.
 */
function createColorThumbnail(
  imageData: Uint8ClampedArray,
  originalWidth: number,
  originalHeight: number,
  maxSize: number = 64
): { data: Uint8ClampedArray; width: number; height: number } {
  const aspectRatio = originalWidth / originalHeight;
  let tw = maxSize, th = maxSize;
  if (aspectRatio > 1) { th = Math.round(maxSize / aspectRatio); }
  else { tw = Math.round(maxSize * aspectRatio); }

  const out = new Uint8ClampedArray(tw * th * 3);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const srcX = Math.floor((x / tw) * originalWidth);
      const srcY = Math.floor((y / th) * originalHeight);
      const si = (srcY * originalWidth + srcX) * 3;
      const di = (y * tw + x) * 3;
      out[di] = imageData[si] || 0;
      out[di + 1] = imageData[si + 1] || 0;
      out[di + 2] = imageData[si + 2] || 0;
    }
  }
  return { data: out, width: tw, height: th };
}

/**
 * Convert grayscale image data to JPEG blob via canvas.
 */
async function grayscaleToJpegBlob(
  imageData: Uint8ClampedArray, width: number, height: number, quality: number = 0.8
): Promise<Blob | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    const cid = ctx.createImageData(width, height);
    const d = cid.data;
    for (let i = 0; i < imageData.length; i++) {
      const p = i * 4;
      d[p] = d[p + 1] = d[p + 2] = imageData[i];
      d[p + 3] = 255;
    }
    ctx.putImageData(cid, 0, 0);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
  } catch (error) {
    console.error('❌ Error converting grayscale to JPEG:', error.message);
    return null;
  }
}

/**
 * Convert RGB triplet image data to JPEG blob via canvas.
 */
async function colorToJpegBlob(
  imageData: Uint8ClampedArray, width: number, height: number, quality: number = 0.8
): Promise<Blob | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    const cid = ctx.createImageData(width, height);
    const d = cid.data;
    const pixelCount = width * height;
    for (let i = 0; i < pixelCount; i++) {
      const s = i * 3;
      const p = i * 4;
      d[p] = imageData[s];
      d[p + 1] = imageData[s + 1];
      d[p + 2] = imageData[s + 2];
      d[p + 3] = 255;
    }
    ctx.putImageData(cid, 0, 0);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
  } catch (error) {
    console.error('❌ Error converting color to JPEG:', error.message);
    return null;
  }
}

/**
 * Convert DICOM pixel data directly to JPEG blob for thumbnail display.
 * Handles MONOCHROME1, MONOCHROME2, RGB, YBR_FULL, YBR_FULL_422.
 */
export async function dicomToJpegBlob(
  imageData: DicomImageData,
  maxSize: number = 64,
  quality: number = 0.8
): Promise<Blob | null> {
  try {
    const { width, height, pixelData, windowCenter, windowWidth, rescaleIntercept, rescaleSlope,
      photometricInterpretation = 'MONOCHROME2', planarConfiguration = 0 } = imageData;

    const pi = photometricInterpretation.toUpperCase();
    const isColor = ['RGB', 'YBR_FULL', 'YBR_FULL_422'].includes(pi);

    if (isColor) {
      const rgbData = extractColorData(pixelData, width, height, pi, planarConfiguration);
      const thumb = createColorThumbnail(rgbData, width, height, maxSize);
      return await colorToJpegBlob(thumb.data, thumb.width, thumb.height, quality);
    } else {
      const invert = pi === 'MONOCHROME1';
      const windowedData = applyWindowingToPixelData(
        pixelData, width, height, windowCenter, windowWidth, rescaleIntercept, rescaleSlope, invert
      );
      const thumb = createGrayscaleThumbnail(windowedData, width, height, maxSize);
      return await grayscaleToJpegBlob(thumb.data, thumb.width, thumb.height, quality);
    }
  } catch (error) {
    console.error('❌ Error creating JPEG blob:', error.message);
    return null;
  }
}

/**
 * Convert DICOM pixel data to a data URL for use in img elements.
 */
export async function dicomToDataUrl(imageData: DicomImageData, maxSize: number = 64): Promise<string | null> {
  const blob = await dicomToJpegBlob(imageData, maxSize);
  if (!blob) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// Legacy function name for backward compatibility
export function parseDicomPixelData(rawData: ArrayBuffer): DicomImageData | null {
  console.warn('⚠️ parseDicomPixelData called but raw pixel data has no DICOM headers');
  console.warn('Use processRawPixelData() with known image dimensions instead');
  return null;
}
