import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { BoardAlert } from "../types";

const PREFS_KEY = "command-center.alerts-prefs.v1";

export type AlertsPrefs = {
  /** Keep the right pane open even when the feed is empty. */
  pinned: boolean;
  /** Prefer auto-open when new visible alerts arrive (default true). */
  autoOpen: boolean;
  /**
   * Alert ids ignored until Alerts settings change (or user clears ignores).
   * Changing any Alerts preference bumps `settingsEpoch` and clears this list.
   */
  ignoredPersistent: string[];
  settingsEpoch: number;
};

type AlertsContextValue = {
  prefs: AlertsPrefs;
  /** Alerts currently published by mounted source windows (pre-ignore filter). */
  published: BoardAlert[];
  /** Visible after ignore filters. */
  visible: BoardAlert[];
  /** Session-only ignores (cleared on reload). */
  ignoredTemporary: Set<string>;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Detail popup selection (click an alert in the pane). */
  selectedId: string | null;
  selected: BoardAlert | null;
  openAlert: (alertId: string) => void;
  closeAlert: () => void;
  publishSourceAlerts: (sourceId: string, alerts: BoardAlert[]) => void;
  clearSourceAlerts: (sourceId: string) => void;
  ignoreTemporary: (alertId: string) => void;
  ignorePersistent: (alertId: string) => void;
  clearPersistentIgnores: () => void;
  updatePrefs: (patch: Partial<Pick<AlertsPrefs, "pinned" | "autoOpen">>) => void;
  togglePin: () => void;
};

const AlertsContext = createContext<AlertsContextValue | null>(null);

function defaultPrefs(): AlertsPrefs {
  return {
    pinned: false,
    autoOpen: true,
    ignoredPersistent: [],
    settingsEpoch: 0,
  };
}

function readPrefs(): AlertsPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw) as Partial<AlertsPrefs>;
    return {
      pinned: Boolean(parsed.pinned),
      autoOpen: parsed.autoOpen !== false,
      ignoredPersistent: Array.isArray(parsed.ignoredPersistent)
        ? parsed.ignoredPersistent.filter((id): id is string => typeof id === "string")
        : [],
      settingsEpoch:
        typeof parsed.settingsEpoch === "number" && Number.isFinite(parsed.settingsEpoch)
          ? parsed.settingsEpoch
          : 0,
    };
  } catch {
    return defaultPrefs();
  }
}

function writePrefs(prefs: AlertsPrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/** Same rows, including USGS magnitude revisions that keep the event id. */
function sameBoardAlerts(prev: BoardAlert[], next: BoardAlert[]): boolean {
  if (prev.length !== next.length) return false;
  return prev.every((item, i) => {
    const other = next[i];
    return (
      other != null &&
      item.id === other.id &&
      item.title === other.title &&
      item.summary === other.summary &&
      item.body === other.body &&
      item.severity === other.severity &&
      item.category === other.category &&
      item.occurredAt === other.occurredAt &&
      item.detailUrl === other.detailUrl
    );
  });
}

export function AlertsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<AlertsPrefs>(() =>
    typeof window === "undefined" ? defaultPrefs() : readPrefs(),
  );
  const [bySource, setBySource] = useState<Record<string, BoardAlert[]>>({});
  const [ignoredTemporary, setIgnoredTemporary] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const [primed, setPrimed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    writePrefs(prefs);
  }, [prefs]);

  const published = useMemo(() => {
    const all = Object.values(bySource).flat();
    all.sort((a, b) => {
      const severityRank = (s: BoardAlert["severity"]) =>
        s === "alert" ? 0 : s === "warn" ? 1 : 2;
      const sev = severityRank(a.severity) - severityRank(b.severity);
      if (sev !== 0) return sev;
      const at = a.occurredAt ? Date.parse(a.occurredAt) : 0;
      const bt = b.occurredAt ? Date.parse(b.occurredAt) : 0;
      return bt - at;
    });
    return all;
  }, [bySource]);

  const persistentSet = useMemo(
    () => new Set(prefs.ignoredPersistent),
    [prefs.ignoredPersistent],
  );

  const visible = useMemo(
    () =>
      published.filter(
        (a) => !ignoredTemporary.has(a.id) && !persistentSet.has(a.id),
      ),
    [published, ignoredTemporary, persistentSet],
  );

  const selected = useMemo(
    () => published.find((a) => a.id === selectedId) ?? null,
    [published, selectedId],
  );

  // Drop selection if the source window unpublishes / alert disappears.
  useEffect(() => {
    if (selectedId && !published.some((a) => a.id === selectedId)) {
      setSelectedId(null);
    }
  }, [published, selectedId]);

  // Self-open when visible alerts appear; collapse when empty unless pinned.
  useEffect(() => {
    if (!primed) {
      setPrimed(true);
      if (prefs.pinned || (prefs.autoOpen && visible.length > 0)) {
        setOpen(true);
      }
      return;
    }
    if (visible.length === 0) {
      if (!prefs.pinned) setOpen(false);
      return;
    }
    if (prefs.autoOpen || prefs.pinned) {
      setOpen(true);
    }
  }, [visible.length, prefs.pinned, prefs.autoOpen, primed]);

  const publishSourceAlerts = useCallback((sourceId: string, alerts: BoardAlert[]) => {
    setBySource((prev) => {
      const prevList = prev[sourceId] ?? [];
      if (sameBoardAlerts(prevList, alerts)) return prev;
      return { ...prev, [sourceId]: alerts };
    });
  }, []);

  const clearSourceAlerts = useCallback((sourceId: string) => {
    setBySource((prev) => {
      if (!(sourceId in prev)) return prev;
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
  }, []);

  const openAlert = useCallback((alertId: string) => {
    setSelectedId(alertId);
    setOpen(true);
  }, []);

  const closeAlert = useCallback(() => {
    setSelectedId(null);
  }, []);

  const ignoreTemporary = useCallback((alertId: string) => {
    setIgnoredTemporary((prev) => {
      const next = new Set(prev);
      next.add(alertId);
      return next;
    });
    setSelectedId((cur) => (cur === alertId ? null : cur));
  }, []);

  const ignorePersistent = useCallback((alertId: string) => {
    setPrefs((prev) => {
      if (prev.ignoredPersistent.includes(alertId)) return prev;
      return {
        ...prev,
        ignoredPersistent: [...prev.ignoredPersistent, alertId],
      };
    });
    setSelectedId((cur) => (cur === alertId ? null : cur));
  }, []);

  const clearPersistentIgnores = useCallback(() => {
    setPrefs((prev) => ({
      ...prev,
      ignoredPersistent: [],
      settingsEpoch: prev.settingsEpoch + 1,
    }));
  }, []);

  const updatePrefs = useCallback(
    (patch: Partial<Pick<AlertsPrefs, "pinned" | "autoOpen">>) => {
      setPrefs((prev) => {
        const next: AlertsPrefs = {
          ...prev,
          ...patch,
          // Changing Alerts options clears "until Settings change" ignores.
          ignoredPersistent: [],
          settingsEpoch: prev.settingsEpoch + 1,
        };
        if (next.pinned) setOpen(true);
        return next;
      });
    },
    [],
  );

  const togglePin = useCallback(() => {
    setPrefs((prev) => {
      const pinned = !prev.pinned;
      if (pinned) setOpen(true);
      return {
        ...prev,
        pinned,
        ignoredPersistent: [],
        settingsEpoch: prev.settingsEpoch + 1,
      };
    });
  }, []);

  const value = useMemo<AlertsContextValue>(
    () => ({
      prefs,
      published,
      visible,
      ignoredTemporary,
      open,
      setOpen,
      selectedId,
      selected,
      openAlert,
      closeAlert,
      publishSourceAlerts,
      clearSourceAlerts,
      ignoreTemporary,
      ignorePersistent,
      clearPersistentIgnores,
      updatePrefs,
      togglePin,
    }),
    [
      prefs,
      published,
      visible,
      ignoredTemporary,
      open,
      selectedId,
      selected,
      openAlert,
      closeAlert,
      publishSourceAlerts,
      clearSourceAlerts,
      ignoreTemporary,
      ignorePersistent,
      clearPersistentIgnores,
      updatePrefs,
      togglePin,
    ],
  );

  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

export function useAlerts(): AlertsContextValue {
  const ctx = useContext(AlertsContext);
  if (!ctx) {
    throw new Error("useAlerts must be used within AlertsProvider");
  }
  return ctx;
}

export { boardAlertId, weatherSeverityToBoard } from "./boardAlerts";
