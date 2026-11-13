import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type SourceRefreshContextValue = {
  /** Monotonic revision per source id; bumps when Settings saves that source. */
  revisions: Record<string, number>;
  revisionOf: (sourceId: string) => number;
  /** Call after a successful source upsert so every bound panel remounts/refetches. */
  notifySourceSaved: (sourceId: string) => void;
};

const SourceRefreshContext = createContext<SourceRefreshContextValue | null>(null);

export function SourceRefreshProvider({ children }: { children: ReactNode }) {
  const [revisions, setRevisions] = useState<Record<string, number>>({});

  const notifySourceSaved = useCallback((sourceId: string) => {
    setRevisions((prev) => ({
      ...prev,
      [sourceId]: (prev[sourceId] ?? 0) + 1,
    }));
  }, []);

  const revisionOf = useCallback(
    (sourceId: string) => revisions[sourceId] ?? 0,
    [revisions],
  );

  const value = useMemo(
    () => ({ revisions, revisionOf, notifySourceSaved }),
    [revisions, revisionOf, notifySourceSaved],
  );

  return (
    <SourceRefreshContext.Provider value={value}>{children}</SourceRefreshContext.Provider>
  );
}

export function useSourceRefresh(): SourceRefreshContextValue {
  const ctx = useContext(SourceRefreshContext);
  if (!ctx) {
    throw new Error("useSourceRefresh requires SourceRefreshProvider");
  }
  return ctx;
}

/** Safe for optional usage outside the provider (tests / isolated mounts). */
export function useSourceRevision(sourceId: string): number {
  const ctx = useContext(SourceRefreshContext);
  return ctx?.revisionOf(sourceId) ?? 0;
}
