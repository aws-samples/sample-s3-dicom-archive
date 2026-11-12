import { useEffect, useState } from 'react';
import { Destination, nonDicomImportV2Service } from '../services/nonDicomImportV2Service';

/**
 * Whether Non-DICOM Import V2 is offered to this user: the runtime flag
 * `nonDicomImportV2` is true AND GET /non-dicom-import/v2/destinations returns
 * at least one writable destination with canStore. The server enforces every
 * check again; this only decides what the UI shows.
 */
export function useNonDicomImportV2(active = true) {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!active) { setEnabled(false); setDestinations([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const on = await nonDicomImportV2Service.isEnabled();
      const list = on ? await nonDicomImportV2Service.getDestinations() : [];
      if (cancelled) return;
      setEnabled(on);
      setDestinations(list);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [active]);

  return { enabled, destinations, loading, available: enabled && destinations.length > 0 };
}
