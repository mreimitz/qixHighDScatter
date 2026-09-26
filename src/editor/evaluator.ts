/**
 * Evaluates the editor's expressions (`=vThroatX`) in the engine through ONE
 * short-lived session object whose properties hold a qValueExpression per
 * expression; its layout carries the values. Destroyed when the editor closes.
 */
export interface Evaluator {
  evaluate(exprs: string[]): Promise<Record<string, number | null>>;
  /** Text results (colour expressions): qStringExpression per expression. */
  evaluateText(exprs: string[]): Promise<Record<string, string | null>>;
  dispose(): void;
}

export function createEvaluator(app: any): Evaluator {
  let model: any = null;
  let creating: Promise<any> | null = null;
  let disposed = false;
  const ensure = () => {
    if (model) return Promise.resolve(model);
    creating ??= Promise.resolve(app?.createSessionObject?.({ qInfo: { qType: "qixHighDScatter-eval" }, e: {} })).then((m) => {
      model = m;
      if (disposed && m) app.destroySessionObject?.(m.id);
      return m;
    });
    return creating;
  };
  // One session object serves both kinds: calls queue so one never
  // overwrites the other's properties mid-flight.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };
  const api = {
    async evaluate(exprs: string[]) {
      const unique = [...new Set(exprs.filter(Boolean))];
      if (!unique.length || !app?.createSessionObject) return {};
      const m = await ensure();
      if (!m || disposed) return {};
      const e: Record<string, unknown> = {};
      unique.forEach((x, i) => (e[`k${i}`] = { qValueExpression: { qExpr: x } }));
      await m.setProperties?.({ qInfo: { qType: "qixHighDScatter-eval", qId: m.id }, e });
      const layout = await m.getLayout();
      const out: Record<string, number | null> = {};
      unique.forEach((x, i) => {
        const v = layout?.e?.[`k${i}`];
        out[x] = typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : null;
      });
      return out;
    },
    async evaluateText(exprs: string[]) {
      const unique = [...new Set(exprs.filter(Boolean))];
      if (!unique.length || !app?.createSessionObject) return {};
      const m = await ensure();
      if (!m || disposed) return {};
      const e: Record<string, unknown> = {};
      unique.forEach((x, i) => (e[`t${i}`] = { qStringExpression: { qExpr: x } }));
      await m.setProperties?.({ qInfo: { qType: "qixHighDScatter-eval", qId: m.id }, e });
      const layout = await m.getLayout();
      const out: Record<string, string | null> = {};
      unique.forEach((x, i) => {
        const v = layout?.e?.[`t${i}`];
        out[x] = v === undefined || v === null ? null : String(v);
      });
      return out;
    },
    dispose() {
      disposed = true;
      if (model) app.destroySessionObject?.(model.id);
    },
  };
  return {
    evaluate: (exprs) => serial(() => api.evaluate(exprs)),
    evaluateText: (exprs) => serial(() => api.evaluateText(exprs)),
    dispose: () => api.dispose(),
  };
}
