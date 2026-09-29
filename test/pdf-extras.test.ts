import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripRunningLines } from '../src/core/context/clean';
import { formatPages } from '../src/core/prompt';

test('running header and footer are removed, body text stays', () => {
  const bodies = ['Starkregen fuehrt zu Abfluss', 'Hitze in dicht bebauten Quartieren', 'Gruene Infrastruktur mindert Hitze', 'Messreihen zeigen Trends ueber Jahre', 'Kartierungen zeigen Unterschiede deutlich'];
  const pages = bodies.map((b, i) => ({ pageNumber: i + 1, text: `Handbuch Stadtklima Seite ${i + 1} ${b} und weitere Worte im Text hier. Lizenz CC BY ${i + 1}` }));
  const { pages: out, removed } = stripRunningLines(pages);
  assert.ok(removed.length >= 1, 'nothing removed');
  assert.ok(out.every((p) => !p.text.startsWith('Handbuch')), out[0].text);
  assert.ok(out[1].text.includes('Hitze in dicht bebauten Quartieren'));
});

test('pages carry the printed label when it differs', () => {
  const text = formatPages([{ pageNumber: 1, text: 'a' }, { pageNumber: 3, text: 'b' }, { pageNumber: 4, text: 'c' }], ['i', null, '1', '4']);
  assert.equal(text, '[Page 1] (printed i)\na\n\n[Page 3] (printed 1)\nb\n\n[Page 4]\nc');
});
