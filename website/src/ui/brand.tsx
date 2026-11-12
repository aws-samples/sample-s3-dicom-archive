import React, { useId } from 'react';

/**
 * DICOM Archive brand mark: three stacked image planes (a series of slices),
 * solid top plane, lower planes fading. Fixed brand gradient, no tile, so it
 * sits on both light and dark sidebars.
 */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = `bm-${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role="img" aria-label="DICOM Archive">
      <defs>
        <linearGradient id={id} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#0ea5a4" />
        </linearGradient>
      </defs>
      <path d="M16 17.5 4 11.5l12-6 12 6z" fill={`url(#${id})`} />
      <path d="M4 16.5l12 6 12-6" fill="none" stroke={`url(#${id})`} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" opacity="0.75" />
      <path d="M4 21.5l12 6 12-6" fill="none" stroke={`url(#${id})`} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}
