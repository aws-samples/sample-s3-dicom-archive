import { useState, useEffect, useCallback, useRef } from 'react';

// Generic hook for API calls with loading, error, and data state
export function useApi<T>(
  apiCall: () => Promise<T>,
  dependencies: any[] = []
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const apiCallRef = useRef(apiCall);
  
  // Update the ref when apiCall changes
  useEffect(() => {
    apiCallRef.current = apiCall;
  }, [apiCall]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiCallRef.current();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, dependencies);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    refetch
  };
}

// Hook for API calls that can be triggered manually (like form submissions)
export function useAsyncAction<T, P = void>() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<T | null>(null);

  const execute = useCallback(async (apiCall: (params: P) => Promise<T>, params?: P) => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiCall(params as P);
      setData(result);
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setError(errorMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  return {
    execute,
    loading,
    error,
    data,
    reset
  };
}

// Hook for paginated data
export function usePaginatedApi<T>(
  apiCall: (params: any) => Promise<{ items: T[]; totalCount: number; currentPage: number; totalPages: number; hasNextPage: boolean; hasPreviousPage: boolean }>,
  initialParams: any = {}
) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({
    totalCount: 0,
    currentPage: 1,
    totalPages: 0,
    hasNextPage: false,
    hasPreviousPage: false
  });
  const [params, setParams] = useState(initialParams);
  const apiCallRef = useRef(apiCall);
  const isInitialMount = useRef(true);

  // Update the ref when apiCall changes
  useEffect(() => {
    apiCallRef.current = apiCall;
  }, [apiCall]);

  const fetchData = useCallback(async (newParams = params) => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiCallRef.current(newParams);
      setData(result.items);
      setPagination({
        totalCount: result.totalCount,
        currentPage: result.currentPage,
        totalPages: result.totalPages,
        hasNextPage: result.hasNextPage,
        hasPreviousPage: result.hasPreviousPage
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [params]);

  // Only fetch on initial mount and when params change
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      fetchData();
    }
  }, [fetchData]);

  // Fetch when params change (but not on initial mount)
  useEffect(() => {
    if (!isInitialMount.current) {
      fetchData();
    }
  }, [params, fetchData]);

  const updateParams = useCallback((newParams: any) => {
    setParams((prevParams: any) => ({ ...prevParams, ...newParams }));
  }, []);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    pagination,
    updateParams,
    refetch
  };
}
