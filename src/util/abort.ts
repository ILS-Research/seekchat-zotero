/** Abort helpers without Zotero (unit-tested). */

/** `promise`, or a rejection as soon as `signal` aborts (the promise itself runs on). */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * One call per key, shared by several waiters. The call runs on `signal` (the whole question), each waiter
 * waits with its own signal: a waiter that gives up (a skipped book) stops only its own wait, never the
 * call the others still need.
 */
export class SharedCalls<T> {
  private calls = new Map<string, Promise<T>>();

  constructor(private signal: AbortSignal) {}

  get(key: string, start: (signal: AbortSignal) => Promise<T>, waiter: AbortSignal): Promise<T> {
    let call = this.calls.get(key);
    if (!call) {
      call = start(this.signal);
      this.calls.set(key, call);
    }
    return untilAborted(call, waiter);
  }
}
