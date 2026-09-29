/**
 * Reads the outline (bookmarks) straight from the PDF file with the pdf.js
 * that ships with Zotero's reader. Independent of an open reader tab: Zotero
 * 10's reader only loads the outline while its sidebar shows the outline view.
 *
 * pdf.js needs DOM and Worker APIs, which the plugin sandbox lacks, so the
 * module is imported into Zotero's main window (a privileged document).
 */
import type { ReaderOutlineItem } from './outline';

const PDFJS_URL = 'resource://zotero/reader/pdf/build/pdf.mjs';
const PDFJS_WORKER_URL = 'resource://zotero/reader/pdf/build/pdf.worker.mjs';

let pdfjsPromise: Promise<any> | null = null;

function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    const win = Zotero.getMainWindow();
    pdfjsPromise = (win.eval(`import(${JSON.stringify(PDFJS_URL)})`) as Promise<any>).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return mod;
    });
    // A failed load is not cached, so the next call retries.
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

/** 0-based page index of an outline destination, or -1. */
async function pageIndexOf(doc: any, dest: unknown): Promise<number> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return -1;
    const ref = explicit[0];
    return typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
  } catch {
    return -1;
  }
}

async function convert(doc: any, items: any[] | null, depth: number): Promise<ReaderOutlineItem[]> {
  const out: ReaderOutlineItem[] = [];
  for (const it of items || []) {
    out.push({
      title: String(it.title || ''),
      location: { position: { pageIndex: await pageIndexOf(doc, it.dest) } },
      // Three levels: the picker shows two, one spare for a single root entry that gets unwrapped.
      items: depth < 2 ? await convert(doc, it.items, depth + 1) : [],
    });
  }
  return out;
}

/** Outline of a PDF attachment in the reader's item shape; [] if the PDF has none. */
export async function readPdfOutline(attachment: any): Promise<ReaderOutlineItem[]> {
  const path = await attachment.getFilePathAsync();
  if (!path) return [];
  const win = Zotero.getMainWindow();
  const bytes: Uint8Array = await win.IOUtils.read(path);
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  const doc = await task.promise;
  try {
    return await convert(doc, await doc.getOutline(), 0);
  } finally {
    await task.destroy();
  }
}

/** Printed page label per physical page (index 0 = page 1), null if the PDF defines none. */
export async function readPageLabels(attachment: any): Promise<(string | null)[] | null> {
  const path = await attachment.getFilePathAsync();
  if (!path) return null;
  const win = Zotero.getMainWindow();
  const bytes: Uint8Array = await win.IOUtils.read(path);
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  const doc = await task.promise;
  try {
    const raw = await doc.getPageLabels();
    return Array.isArray(raw) ? raw.map((l: unknown) => (typeof l === 'string' && l ? l : null)) : null;
  } finally {
    await task.destroy();
  }
}
