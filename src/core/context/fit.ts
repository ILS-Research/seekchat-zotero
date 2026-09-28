/** Does a document fit into the prompt budget? Pure, unit-tested. */
import { currentLocale } from '../../i18n';
import type { Page } from './types';

/** Rough token estimate for mixed German/English prose (~3.5 characters per token). */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface FitInfo {
  fits: boolean;
  pageCount: number;
  totalChars: number;
  totalTokens: number;
  budgetChars: number;
  budgetTokens: number;
}

export function analyzeFit(pages: Page[], budgetChars: number): FitInfo {
  const totalChars = pages.reduce((s, p) => s + p.text.length, 0);
  return {
    fits: totalChars <= budgetChars,
    pageCount: pages.length,
    totalChars,
    totalTokens: estimateTokens(totalChars),
    budgetChars,
    budgetTokens: estimateTokens(budgetChars),
  };
}

/** 12345 -> "12,345" (English) / "12.345" (German). */
export function formatCount(n: number): string {
  const sep = currentLocale() === 'de' ? '.' : ',';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
