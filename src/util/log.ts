export function log(msg: string): void {
  Zotero.debug(`[SeekChat] ${msg}`);
}

export function logError(e: unknown): void {
  Zotero.debug(`[SeekChat] ERROR ${e}`);
  Zotero.logError(e);
}
