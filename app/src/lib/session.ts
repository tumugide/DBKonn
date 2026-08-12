import type { AppTab, ConnSession } from "./store";

// ── Session persistence ────────────────────────────────────────────────────────
// Remembers every open connection (and each one's open tabs) so they come
// back after relaunching the app, as long the user didn't explicitly close
// them (or disconnect) first.

const SESSION_KEY = "dbkonn-session";

export interface StoredConnSession {
  connConfigId: string;
  activeTabId: string | null;
  tabs: AppTab[];
  selectedDatabase?: string;
  selectedSchema?: string;
}

export interface StoredSession {
  activeConnConfigId: string | null;
  sessions: StoredConnSession[];
}

// Strip heavy/ephemeral fields (result sets, in-progress row edits) before
// writing to localStorage — only the lightweight "what was open" state
// (query text, filters, sort, selected table) needs to survive a restart.
function toLightTab(tab: AppTab): AppTab {
  if (tab.kind === "table") {
    return {
      ...tab,
      tableState: { ...tab.tableState, result: undefined },
      selectedRecord: null,
    };
  }
  return { ...tab, sqlResult: null };
}

export function saveSession(sessions: ConnSession[], activeConnConfigId: string | null) {
  const payload: StoredSession = {
    activeConnConfigId,
    sessions: sessions.map((s) => ({
      connConfigId: s.config.id,
      activeTabId: s.activeTabId,
      tabs: s.openTabs.map(toLightTab),
      selectedDatabase: s.selectedDatabase,
      selectedSchema: s.selectedSchema,
    })),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable or full — session restore is best-effort */
  }
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
