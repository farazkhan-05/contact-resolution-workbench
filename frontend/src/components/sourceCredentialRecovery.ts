// Only operation identifiers are retained. One-time keys never enter this store.
type Phase = 'pending' | 'unknown';
type Recovery = Readonly<Record<string, Phase>>;
const states = new Map<string, Recovery>();
const listeners = new Set<() => void>();
const empty: Recovery = {};
const storageKey = (workspaceId: string) => `crw.source-credential-unconfirmed:${workspaceId}`;

export const subscribeSourceRecovery = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function sourceRecovery(workspaceId: string | undefined): Recovery {
  if (!workspaceId) return empty;
  if (!states.has(workspaceId)) {
    let restored: Record<string, Phase> = {};
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(workspaceId)) || '[]');
      if (Array.isArray(saved)) restored = Object.fromEntries(saved
        .filter((key): key is string => typeof key === 'string' && (key === 'create' || key.startsWith('rotate:')))
        .map(key => [key, 'unknown']));
    } catch { /* Storage restrictions leave active-page recovery available. */ }
    states.set(workspaceId, restored);
  }
  return states.get(workspaceId)!;
}
export function updateSourceRecovery(workspaceId: string, operation: string, phase?: Phase) {
  const next = { ...sourceRecovery(workspaceId) };
  if (phase) next[operation] = phase; else delete next[operation];
  states.set(workspaceId, next);
  try {
    const operations = Object.keys(next);
    if (operations.length) sessionStorage.setItem(storageKey(workspaceId), JSON.stringify(operations));
    else sessionStorage.removeItem(storageKey(workspaceId));
  } catch { /* No key or response payload is persisted, including on storage failure. */ }
  listeners.forEach(listener => listener());
}
