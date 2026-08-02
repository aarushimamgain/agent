import { useEffect, useRef, useState, useCallback } from 'react';

// Calls `fetchFn` immediately, then again every `intervalMs` while `enabled`
// is true - the mechanism behind "poll the backend every few seconds for
// updates" on the workflow and run detail screens. There's no websocket/SSE
// here on purpose: polling is simple, easy to reason about, and plenty fast
// enough for a demo where a run finishes in well under a second per step.
//
// `deps` re-triggers the initial fetch (e.g. when the run id in the URL
// changes); `enabled` is what a caller flips to false once a run reaches a
// terminal state, so a finished run stops being polled forever.
export function usePolling(fetchFn, { intervalMs = 3000, enabled = true } = {}, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  const refetch = useCallback(async () => {
    try {
      const result = await fetchFnRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function tick() {
      try {
        const result = await fetchFnRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    tick();
    let interval;
    if (enabled) {
      interval = setInterval(tick, intervalMs);
    }
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...deps]);

  return { data, error, loading, refetch };
}
