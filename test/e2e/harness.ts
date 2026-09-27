/** Runs the E2E scenarios inside Zotero and reports to a JSON file. */
import { scenarios } from './scenarios';

export interface E2EContext {
  fixturesDir: string;
  outDir: string;
  [key: string]: any;
}

export function delay(ms: number): Promise<void> {
  return Zotero.Promise.delay(ms);
}

/** Polls fn until it returns a truthy value, or fails with `what` after timeoutMs. */
export async function waitFor<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 15000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      lastError = e;
    }
    await delay(100);
  }
  throw new Error(`Timeout waiting for ${what}${lastError ? ` (last error: ${lastError})` : ''}`);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** PNG of the main window, for debugging failed UI steps. Best effort. */
export async function screenshot(ctx: E2EContext, name: string): Promise<void> {
  try {
    const win = Zotero.getMainWindow();
    const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = win.innerWidth;
    canvas.height = win.innerHeight;
    const g = canvas.getContext('2d');
    g.drawWindow(win, 0, 0, canvas.width, canvas.height, 'rgb(255,255,255)');
    const b64 = canvas.toDataURL('image/png').split(',')[1];
    const bytes = Uint8Array.from(win.atob(b64), (c: string) => c.charCodeAt(0));
    await win.IOUtils.write(`${ctx.outDir}/screenshot-${name}.png`, bytes);
  } catch (e) {
    Zotero.debug(`[SeekChat E2E] screenshot ${name} failed: ${e}`);
  }
}

export async function runAll(): Promise<void> {
  const resultsPath = Zotero.Prefs.get('seekchat.e2e.resultsPath');
  const ctx: E2EContext = {
    fixturesDir: Zotero.Prefs.get('seekchat.e2e.fixturesDir'),
    outDir: Zotero.Prefs.get('seekchat.e2e.outDir'),
  };
  const results: { name: string; ok: boolean; ms: number; error?: string }[] = [];
  try {
    Zotero.debug('[SeekChat E2E] waiting for the main window');
    await waitFor('main window with ZoteroPane', () => Zotero.getMainWindow()?.ZoteroPane?.itemsView, 60000);
    await delay(1000);
    Zotero.debug('[SeekChat E2E] running scenarios');
    for (const [name, fn] of scenarios) {
      const t0 = Date.now();
      try {
        await fn(ctx);
        results.push({ name, ok: true, ms: Date.now() - t0 });
      } catch (e: any) {
        results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message || e) });
        await screenshot(ctx, name.replace(/\W+/g, '_'));
      }
      Zotero.debug(`[SeekChat E2E] ${results[results.length - 1].ok ? 'ok' : 'FAIL'} ${name}`);
    }
    await screenshot(ctx, 'final');
  } catch (e: any) {
    results.push({ name: 'harness', ok: false, ms: 0, error: String(e?.message || e) });
  } finally {
    await Zotero.File.putContentsAsync(resultsPath, JSON.stringify({ zoteroVersion: Zotero.version, results }, null, 2));
    Zotero.Utilities.Internal.quit();
  }
}
