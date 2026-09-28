import { test } from 'node:test';
import assert from 'node:assert/strict';
import { I18N_TABLES, languageName, setLocale, t, tn } from '../src/i18n';
import { defaultSystemPrompt } from '../src/core/prompt';
import { formatCount } from '../src/core/context/fit';

test('every English key has a German translation with the same placeholders', () => {
  const en = I18N_TABLES.en;
  const de = I18N_TABLES.de;
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  const vars = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const key of Object.keys(en) as (keyof typeof en)[]) assert.equal(vars(de[key]), vars(en[key]), key);
});

test('English is the default outside Zotero; German on request', () => {
  setLocale(null);
  assert.equal(t('common.send'), 'Send');
  assert.equal(tn('lib.items', 2), '2 selected items');
  assert.equal(languageName('de'), 'German');
  assert.equal(formatCount(12345), '12,345');
  assert.match(defaultSystemPrompt(), /format \[p\. 12\]/);
  setLocale('de');
  assert.equal(t('common.send'), 'Senden');
  assert.equal(tn('lib.items', 1), '1 ausgewählter Eintrag');
  assert.equal(formatCount(12345), '12.345');
  assert.match(defaultSystemPrompt(), /format \[S\. 12\]/);
  assert.ok(defaultSystemPrompt().startsWith('You are a scientific assistant'), 'prompts stay English');
  setLocale(null);
});
