import type { AppTab } from "./store";

// ── Session persistence ────────────────────────────────────────────────────────
// Remembers the open tabs (table + query) for the last active connection so
// they come back after relaunching the app, as long as the user didn't
// explicitly close them (or disconnect) first.

const SESSION_KEY = "dbkonn-session";

export interface StoredSession {
  connConfigId: string;
  activeTabId: string | null;
  tabs: AppTab[];
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

export function saveSession(connConfigId: string, activeTabId: string | null, tabs: AppTab[]) {
  const payload: StoredSession = {
    connConfigId,
    activeTabId,
    tabs: tabs.map(toLightTab),
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
