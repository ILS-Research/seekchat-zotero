/**
 * Text lines describing what happened to each book of a library question: shown in
 * the chat window and written into the Markdown export and the note, so the
 * record of a question is complete.
 */
import { t, tn, type Key } from '../i18n';
import { compressRanges } from './prompt';
import type { BookProgress } from './session';

export function bookStateText(b: BookProgress): string {
  switch (b.state) {
    case 'found': return tn('meta.passages', b.found ?? 0);
    case 'error': return t('book.error', { message: b.error || '' });
    default: return t(`book.${b.state}` as Key);
  }
}

/** Like the PDF chat's meta line, per book: language and its source, own search terms, pages sent. */
export function bookDetails(b: BookProgress): string[] {
  const out: string[] = [];
  if (b.languageSource || b.language) {
    const source = t(b.languageSource === 'metadata' ? 'meta.languageMetadata' : b.languageSource === 'model' ? 'meta.languageModel' : 'meta.languageGuess');
    out.push(b.language ? t('meta.language', { language: b.language, source }) : t('book.languageUnknown'));
  }
  if (b.keywords) out.push(b.keywords.length ? t('meta.keywords', { keywords: b.keywords.join(', ') }) : t('meta.noKeywords'));
  if (b.pages?.length) out.push(t('book.pagesSent', { n: b.pages.length, total: b.totalPages ?? '?', pageLabel: t('cite.page'), pages: compressRanges(b.pages) }));
  return out;
}
