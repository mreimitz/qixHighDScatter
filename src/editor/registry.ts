/**
 * Bridge between the property panel's "Edit zones…" button (whose action only
 * receives the object's properties) and the chart instance that opens the
 * modal. Keyed by the object's qId; each mounted chart registers itself.
 */
const openers = new Map<string, () => void>();

export function registerEditor(qId: string, open: () => void): () => void {
  openers.set(qId, open);
  return () => {
    if (openers.get(qId) === open) openers.delete(qId);
  };
}

// The panel's button, reachable from a test page (no property panel there).
if (typeof window !== "undefined") (window as any).__qhdsOpenEditor = (qId: string) => openEditor(qId);

export function openEditor(qId: string | undefined): boolean {
  const open = qId ? openers.get(qId) : undefined;
  if (open) open();
  return Boolean(open);
}
