import React, { useState } from 'react';
import { Modal } from '@cloudscape-design/components';
import NonDicomImportV2, { FixedStudy } from './NonDicomImportV2';
import type { DestinationKind } from '../services/nonDicomImportV2Service';

/**
 * "Attach files" on a study: the Non-DICOM Import V2 flow with the destination
 * and study fixed (step 2 skipped). Asks before discarding uploaded,
 * unsubmitted files when the modal is dismissed.
 */
const AttachFilesModal: React.FC<{
  visible: boolean;
  onClose: () => void;
  destination: { kind: DestinationKind; id: string; name?: string };
  study: FixedStudy;
}> = ({ visible, onClose, destination, study }) => {
  const [dirty, setDirty] = useState(false);
  const dismiss = () => {
    if (dirty && !window.confirm('Close the import? The files you added are not imported.')) return;
    setDirty(false);
    onClose();
  };
  return (
    <Modal visible={visible} onDismiss={dismiss} size="max" header="Attach files to study" closeAriaLabel="Close attach files">
      {visible && (
        <NonDicomImportV2
          embedded
          fixedDestination={{ kind: destination.kind, id: destination.id }}
          fixedStudy={study}
          onDirtyChange={setDirty}
          onClose={() => { setDirty(false); onClose(); }}
        />
      )}
    </Modal>
  );
};

export default AttachFilesModal;
