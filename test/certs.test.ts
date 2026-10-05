import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certInfoOf, findCert, parseCertList, removeCert, toPem, upsertCert, type CertInfo } from '../src/core/certs';

const info = (sha = 'AA:BB', port = 443): CertInfo => ({
  host: 'ollama.ils.local', port, sha256: sha, subject: 'CN=ollama.ils.local', commonName: 'ollama.ils.local',
  issuer: 'CN=Selbst', notBefore: '2026-01-01', notAfter: '2027-01-01', der: 'MIIB',
});

test('certificate list: broken pref text and foreign entries are left out', () => {
  assert.deepEqual(parseCertList(''), []);
  assert.deepEqual(parseCertList('{nope'), []);
  assert.deepEqual(parseCertList('{"a":1}'), []);
  const list = parseCertList(JSON.stringify([{ ...info(), trusted: true, decided: 'x' }, { host: 1 }, { ...info('CC'), port: '8443', trusted: 'yes' }]));
  assert.equal(list.length, 2);
  assert.equal(list[1].port, 8443);
  assert.equal(list[1].trusted, false);
});

test('certificate decision: added, changed, found only for the same host, port and fingerprint, removed', () => {
  let list = upsertCert([], info(), true, new Date('2026-10-05T00:00:00Z'));
  assert.equal(list.length, 1);
  assert.equal(list[0].decided, '2026-10-05T00:00:00.000Z');
  assert.equal(list[0].der, 'MIIB');
  list = upsertCert(list, info(), false);
  assert.equal(list.length, 1);
  assert.equal(findCert(list, info('aa:bb'))?.trusted, false);
  assert.equal(findCert(list, info('AA:BC')), undefined);
  assert.equal(findCert(list, info('AA:BB', 8443)), undefined);
  list = upsertCert(list, info('CC'), true);
  assert.equal(removeCert(list, info()).length, 1);
});

test('PEM: base64 in lines of 64 between the markers', () => {
  const pem = toPem('A'.repeat(100));
  assert.equal(pem, `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n${'A'.repeat(36)}\n-----END CERTIFICATE-----\n`);
});

test('certificate info from an nsIX509Cert-like object', () => {
  const c = certInfoOf({
    sha256Fingerprint: 'ab:cd', subjectName: 'CN=x', commonName: 'x', issuerName: 'CN=ca',
    validity: { notBefore: Date.UTC(2026, 0, 2) * 1000, notAfter: Date.UTC(2027, 0, 2) * 1000 }, getBase64DERString: () => 'MII',
  }, 'x', 443, 'SEC_ERROR_UNKNOWN_ISSUER');
  assert.deepEqual(c, {
    host: 'x', port: 443, sha256: 'AB:CD', subject: 'CN=x', commonName: 'x', issuer: 'CN=ca',
    notBefore: '2026-01-02', notAfter: '2027-01-02', der: 'MII', error: 'SEC_ERROR_UNKNOWN_ISSUER',
  });
});
