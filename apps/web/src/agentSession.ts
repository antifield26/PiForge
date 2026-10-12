/**
 * Remembered Agent session id.
 *
 * Lives outside the panel so the app shell can clear it on logout / an expired session: leaving
 * it behind means the next person to log in on the same browser is dropped straight into the
 * previous user's conversation.
 */
const STORAGE_KEY = "pf.agentSessionId"

export function readStoredSession(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeSession(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* private mode / storage disabled */
  }
}
