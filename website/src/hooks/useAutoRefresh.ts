import { useState, useEffect, useRef } from 'react';

interface UseAutoRefreshReturn {
  autoRefresh: boolean;
  setAutoRefresh: (value: boolean) => void;
  autoRefreshError: string | null;
  clearError: () => void;
}

export function useAutoRefresh(
  refreshFn: (silent?: boolean) => Promise<void>,
  interval: number = 5000
): UseAutoRefreshReturn {
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoRefreshError, setAutoRefreshError] = useState<string | null>(null);
  const isRefreshing = useRef(false);
  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const clearError = () => {
    setAutoRefreshError(null);
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    if (!autoRefresh) return;

    const intervalId = setInterval(async () => {
      // Prevent overlapping requests
      if (isRefreshing.current) {
        console.log('Auto-refresh skipped: previous request still in progress');
        return;
      }

      isRefreshing.current = true;
      try {
        await refreshFn(true); // Pass true for silent mode during auto-refresh
        // Clear error on successful refresh
        if (autoRefreshError) {
          clearError();
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Auto-refresh failed';
        console.error('Auto-refresh error:', errorMessage);
        setAutoRefreshError(errorMessage);
        
        // Auto-clear error after 10 seconds
        if (errorTimeoutRef.current) {
          clearTimeout(errorTimeoutRef.current);
        }
        errorTimeoutRef.current = setTimeout(() => {
          setAutoRefreshError(null);
        }, 10000);
      } finally {
        isRefreshing.current = false;
      }
    }, interval);

    return () => {
      clearInterval(intervalId);
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, [autoRefresh, refreshFn, interval, autoRefreshError]);

  return {
    autoRefresh,
    setAutoRefresh,
    autoRefreshError,
    clearError
  };
}
