import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export interface AsyncOptions {
  /**
   * Poll interval in milliseconds. The protocol is live, so the surfaces that show live state
   * should show it without the viewer reloading the page.
   */
  refreshMs?: number;
}

/**
 * Minimal data-fetching hook.
 *
 * Deliberately dependency-free: MASTER_PLAN 0.27.L keeps third-party scripts off this app so
 * no library can ever observe a key-reveal surface, and 0.26.A asks that visual effects never
 * cost Core Web Vitals. A small hook is cheaper than a data library in both senses.
 *
 * Polling refreshes NEVER set `loading`. A refresh that flips the page back to a skeleton every
 * few seconds is worse than no refresh at all: it destroys scroll position, collapses open
 * detail, and makes a quiet market look like a broken one. `loading` means "there is nothing to
 * show yet", and after the first success that is never true again.
 *
 * Polling also pauses while the tab is hidden. A background tab that keeps hitting the API is
 * spending someone else's rate limit to render pixels nobody is looking at.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
  options: AsyncOptions = {}
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const hasData = useRef(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = (isRefresh: boolean): Promise<void> => {
      if (!isRefresh) {
        setLoading(true);
        setError(null);
      }
      return run()
        .then((result) => {
          if (cancelled) return;
          hasData.current = true;
          setData(result);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          // A failed refresh keeps the last good data on screen rather than blanking the page;
          // the freshness bar is what tells the viewer the feed has gone quiet.
          if (!hasData.current) setError(err);
        })
        .finally(() => {
          if (!cancelled && !isRefresh) setLoading(false);
        });
    };

    hasData.current = false;
    void fetchOnce(false);

    const refreshMs = options.refreshMs ?? 0;
    if (refreshMs <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void fetchOnce(true);
    }, refreshMs);

    // Catch up immediately when the viewer comes back, rather than waiting a whole interval.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void fetchOnce(true);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run, nonce, options.refreshMs]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
