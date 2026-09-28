import { AsyncLocalStorage } from 'node:async_hooks';
export const execution = new AsyncLocalStorage();
export function checkCancelled() { execution.getStore()?.signal.throwIfAborted(); }
export async function activity(detail, extra = {}) {
  checkCancelled();
  const scope = execution.getStore();
  if (scope) await scope.progress({ detalle: detail, ...extra });
}
export function registerSession(session) {
  const scope = execution.getStore();
  if (!scope) return;
  scope.session = session;
  scope.signal.addEventListener('abort', () => { void session.context.close().catch(() => {}); }, { once: true });
  checkCancelled();
}
