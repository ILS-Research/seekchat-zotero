/**
 * Language of a document, so that model keywords match its wording.
 * Order: the item's "Language" field, else a short model call on the first
 * pages, else a local stopword guess. Parsing and guessing are pure, unit-tested.
 */
import type { ChatMessage } from '../llm/types';
import { stripThinking } from '../llm/stream-parsers';

export interface Language {
  /** ISO 639-1 code, e.g. "de". */
  code: string;
  /** English name for prompts, e.g. "German" (UI: i18n languageName). */
  name: string;
}

export type LanguageSource = 'metadata' | 'model' | 'guess';

const NAMES: Record<string, string> = {
  de: 'German', en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese',
  pl: 'Polish', cs: 'Czech', da: 'Danish', sv: 'Swedish', no: 'Norwegian', fi: 'Finnish', ru: 'Russian',
  tr: 'Turkish', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
};

const ALIASES: Record<string, string> = {
  german: 'de', deutsch: 'de', ger: 'de', deu: 'de',
  english: 'en', englisch: 'en', eng: 'en',
  french: 'fr', français: 'fr', francais: 'fr', französisch: 'fr', fra: 'fr', fre: 'fr',
  spanish: 'es', español: 'es', espanol: 'es', spanisch: 'es', spa: 'es',
  italian: 'it', italiano: 'it', italienisch: 'it', ita: 'it',
  dutch: 'nl', nederlands: 'nl', niederländisch: 'nl', nld: 'nl',
  portuguese: 'pt', português: 'pt', portugiesisch: 'pt', por: 'pt',
  polish: 'pl', polski: 'pl', polnisch: 'pl', pol: 'pl',
};

/** "de-DE", "German", "Deutsch", "ger" -> { code: "de", name: "German" }; null if unknown or empty. */
export function normalizeLanguage(raw: unknown): Language | null {
  if (typeof raw !== 'string') return null;
  // Zotero's field is free text; take the first entry of "de; en" or "German, English".
  const first = raw.trim().toLowerCase().split(/[;,/]/)[0].trim();
  if (!first) return null;
  const base = first.split(/[-_ ]/)[0];
  const code = NAMES[base] ? base : ALIASES[first] || ALIASES[base];
  return code ? { code, name: NAMES[code] } : null;
}

export function buildLanguageMessages(sample: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'Identify the language of the following text excerpt (beginning of a document). ' +
        'Answer only with the two-letter ISO 639-1 code of the main language, e.g. de or en.',
    },
    { role: 'user', content: `${sample}\n/no_think` },
  ];
}

/** Takes the first recognizable language code or name from a model reply. */
export function parseLanguageReply(reply: string): Language | null {
  const text = stripThinking(reply).trim();
  for (const token of text.split(/[^\p{L}-]+/u).filter(Boolean).slice(0, 10)) {
    const lang = normalizeLanguage(token);
    if (lang) return lang;
  }
  return null;
}

const STOPWORDS: Record<string, string[]> = {
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'sich', 'auf', 'für', 'werden', 'eine', 'auch', 'von', 'zu'],
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'with', 'this', 'are', 'be', 'on', 'you', 'can'],
  fr: ['le', 'la', 'les', 'et', 'des', 'est', 'une', 'pour', 'dans', 'que', 'qui', 'pas', 'sur', 'avec', 'du'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'una', 'para', 'con', 'que', 'por', 'del', 'se', 'como', 'más'],
};

/** Rough local guess from stopword frequencies; null if the sample is too short or unclear. */
export function guessLanguage(sample: string): Language | null {
  const words = sample.toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length < 30) return null;
  let best = '';
  let bestCount = 0;
  let second = 0;
  for (const [code, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const count = words.filter((w) => set.has(w)).length;
    if (count > bestCount) {
      second = bestCount;
      bestCount = count;
      best = code;
    } else if (count > second) {
      second = count;
    }
  }
  return bestCount >= 5 && bestCount > second * 1.5 ? { code: best, name: NAMES[best] } : null;
}
