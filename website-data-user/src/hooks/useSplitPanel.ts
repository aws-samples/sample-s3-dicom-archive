import { useState, useEffect } from 'react';
import { AppLayoutProps } from '@cloudscape-design/components/app-layout';

export const useSplitPanel = (selectedStudy: any) => {
  const [splitPanelSize, setSplitPanelSize] = useState(300);
  const [splitPanelOpen, setSplitPanelOpen] = useState(false);
  const [hasManuallyClosedOnce, setHasManuallyClosedOnce] = useState(false);

  const onSplitPanelResize: AppLayoutProps['onSplitPanelResize'] = ({ detail: { size } }) => {
    setSplitPanelSize(size);
  };

  const onSplitPanelToggle: AppLayoutProps['onSplitPanelToggle'] = ({ detail: { open } }) => {
    setSplitPanelOpen(open);
    if (!open) {
      setHasManuallyClosedOnce(true);
    }
  };

  useEffect(() => {
    if (selectedStudy && !hasManuallyClosedOnce) {
      setSplitPanelOpen(true);
    }
  }, [selectedStudy, hasManuallyClosedOnce]);

  return {
    splitPanelOpen,
    onSplitPanelToggle,
    splitPanelSize,
    onSplitPanelResize,
  };
};
