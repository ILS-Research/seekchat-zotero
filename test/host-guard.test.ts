import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedUrl, parseAllowedHosts } from '../src/core/host-guard';
import { setLocale } from '../src/i18n';

// The expectations below are the German UI texts; English is covered in i18n.test.ts.
setLocale('de');

test('loopback is allowed without configuration', () => {
  for (const url of ['http://127.0.0.1:11434', 'http://localhost:1234/v1/models', 'http://[::1]:8080']) {
    assert.doesNotThrow(() => assertAllowedUrl(url, []));
  }
});

test('remote hosts need an explicit, exact entry', () => {
  assert.throws(() => assertAllowedUrl('https://ollama.ils.local', []), { code: 'HOST_REJECTED' });
  const allowed = parseAllowedHosts('ollama.ils.local');
  assert.equal(assertAllowedUrl('https://ollama.ils.local/api/chat', allowed).hostname, 'ollama.ils.local');
  assert.throws(() => assertAllowedUrl('https://ollama.ils.local.evil.com', allowed), { code: 'HOST_REJECTED' });
});

test('credentials and other schemes are rejected', () => {
  const allowed = ['ollama.ils.local'];
  assert.throws(() => assertAllowedUrl('https://u:p@ollama.ils.local', allowed), { code: 'HOST_REJECTED' });
  assert.throws(() => assertAllowedUrl('file:///etc/passwd', allowed), { code: 'HOST_REJECTED' });
});

test('host list parsing normalizes entries', () => {
  assert.deepEqual(parseAllowedHosts(' https://Ollama.ILS.local:443/x, gpu01:11434 gpu01,, '), ['ollama.ils.local', 'gpu01']);
  assert.deepEqual(parseAllowedHosts(undefined), []);
});
