/** Settings pane logic: fields <-> prefs, connection test and model list. */
import { clearLimitsCache, contextWarning, resolveLimits } from '../core/limits';
import { formatCount } from '../core/context/fit';
import { createClient } from '../core/llm';
import { assertAllowedUrl, parseAllowedHosts } from '../core/host-guard';
import { findCert, probeCertificate, readCerts, removeCert, toPem, upsertCert, writeCerts, type CertInfo } from '../core/certs';
import { decideCertificate, forgetServer } from '../core/tls';
import { defaultSystemPrompt } from '../core/prompt';
import { t, type Key } from '../i18n';
import { getPref, readPrefs, setPref } from '../prefs';

const TEXT_PREFS = ['baseUrl', 'apiKey'];
const INT_PREFS = ['temperaturePercent', 'numCtx', 'contextChars', 'maxTokens', 'historyTurns', 'libraryTopK'];

export function onPrefsLoad(win: Window): void {
  const doc = win.document;
  // Texts: English in the xhtml, replaced by the UI language's version here.
  for (const el of Array.from(doc.querySelectorAll('#seekchat-preferences [data-i18n]')) as HTMLElement[]) {
    el.textContent = t(el.dataset.i18n as Key);
  }
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(`seekchat-${id}`) as T | null;
  const status = $('status');
  const setStatus = (text: string) => { if (status) status.textContent = text; };

  const provider = $<HTMLSelectElement>('provider');
  if (provider) {
    provider.value = readPrefs().provider;
    provider.addEventListener('change', () => setPref('provider', provider.value));
  }
  for (const key of TEXT_PREFS) {
    const input = $<HTMLInputElement>(key);
    if (!input) continue;
    input.value = String(getPref(key) ?? '');
    input.addEventListener('change', () => {
      setPref(key, input.value.trim());
      // A new server: check its certificate (asks when the system does not trust it).
      if (key === 'baseUrl') void certs.check('change');
    });
  }
  for (const key of INT_PREFS) {
    const input = $<HTMLInputElement>(key);
    if (!input) continue;
    input.value = String(getPref(key) ?? '');
    input.addEventListener('change', () => {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v)) setPref(key, v);
    });
  }

  const certs = certificatesUi(win, $);

  const thinking = $<HTMLInputElement>('thinking');
  if (thinking) {
    thinking.checked = getPref('thinking') === true;
    thinking.addEventListener('change', () => setPref('thinking', thinking.checked));
  }

  const prompt = $<HTMLTextAreaElement>('systemPrompt');
  if (prompt) {
    prompt.placeholder = defaultSystemPrompt();
    prompt.value = String(getPref('systemPrompt') ?? '');
    prompt.addEventListener('change', () => setPref('systemPrompt', prompt.value.trim()));
  }

  const hosts = $<HTMLInputElement>('allowedRemoteHosts');
  const remoteStatus = $('remote-status');
  const showHosts = (list: string[]) => {
    if (remoteStatus) {
      remoteStatus.textContent = list.length
        ? t('prefs.remoteOn', { hosts: list.join(', ') })
        : t('prefs.remoteOff');
    }
  };
  if (hosts) {
    const list = parseAllowedHosts(getPref('allowedRemoteHosts'));
    hosts.value = list.join(', ');
    showHosts(list);
    hosts.addEventListener('change', () => {
      const parsed = parseAllowedHosts(hosts.value);
      setPref('allowedRemoteHosts', parsed.join(','));
      hosts.value = parsed.join(', ');
      showHosts(parsed);
      void certs.check('change');
    });
  }

  // Limits: tab "auto" shows the values derived from the model, tab "manual" the three inputs.
  const tabAuto = $('limits-auto');
  const tabManual = $('limits-manual');
  const panelAuto = $('limits-auto-panel');
  const panelManual = $('limits-manual-panel');
  const showAuto = async (refresh = false) => {
    if (refresh) clearLimitsCache();
    const set = (id: string, text: string) => { const e = $(id); if (e) e.textContent = text; };
    set('auto-detail', t('prefs.asking'));
    const l = await resolveLimits({ ...readPrefs(), limitsMode: 'auto' });
    set('auto-numCtx', t('prefs.tokens', { n: formatCount(l.numCtx) }));
    set('auto-contextChars', t('prefs.chars', { n: formatCount(l.contextChars), tokens: formatCount(l.contextChars / 3.5) }));
    set('auto-maxTokens', t('prefs.tokens', { n: formatCount(l.maxTokens) }));
    set('auto-detail', t(l.source === 'auto' ? 'prefs.detected' : 'prefs.notDetected', { detail: l.detail }));
    const warning = $('auto-warning');
    if (warning) {
      warning.textContent = contextWarning(l) || '';
      warning.hidden = !contextWarning(l);
    }
  };
  const selectTab = (mode: 'auto' | 'manual') => {
    setPref('limitsMode', mode);
    tabAuto?.classList.toggle('selected', mode === 'auto');
    tabManual?.classList.toggle('selected', mode === 'manual');
    if (panelAuto) panelAuto.hidden = mode !== 'auto';
    if (panelManual) panelManual.hidden = mode !== 'manual';
    if (mode === 'auto') void showAuto();
  };
  tabAuto?.addEventListener('click', () => selectTab('auto'));
  tabManual?.addEventListener('click', () => selectTab('manual'));
  $('auto-refresh')?.addEventListener('click', () => void showAuto(true));
  selectTab(readPrefs().limitsMode);

  const model = $<HTMLSelectElement>('model');
  const fillModels = (names: string[]) => {
    if (!model) return;
    const current = readPrefs().model;
    const all = current && !names.includes(current) ? [current, ...names] : names;
    model.replaceChildren(...all.map((n) => {
      const o = doc.createElementNS('http://www.w3.org/1999/xhtml', 'option') as HTMLOptionElement;
      o.value = n;
      o.textContent = n;
      return o;
    }));
    if (current) model.value = current;
    else if (all.length) setPref('model', (model.value = all[0]));
  };
  fillModels([]);
  model?.addEventListener('change', () => {
    setPref('model', model.value);
    if (readPrefs().limitsMode === 'auto') void showAuto();
  });

  $('test')?.addEventListener('click', async () => {
    setStatus(t('prefs.connecting'));
    try {
      const names = await createClient(readPrefs()).listModels();
      fillModels(names);
      if (readPrefs().limitsMode === 'auto') void showAuto(true);
      setStatus(names.length ? t('prefs.connected', { n: names.length }) : t('prefs.connectedEmpty'));
    } catch (e: any) {
      setStatus(t('common.error', { message: String(e?.message || e) }));
    }
  });
}

/** What started a certificate check. */
type CheckTrigger = 'load' | 'change' | 'button';

type Lookup = <T extends HTMLElement>(id: string) => T | null;

/** Details of a certificate, one per line (dialog, list). */
function certDetails(c: CertInfo): string {
  return t('prefs.certDetails', {
    subject: c.subject || c.commonName || '–', issuer: c.issuer || '–', from: c.notBefore || '?', to: c.notAfter || '?', sha: c.sha256,
  });
}

/**
 * The certificate part of the settings: "Check certificate" next to the server, the dialog for a certificate the
 * system does not trust (trust, do not trust, show it), and the list of decided certificates.
 */
function certificatesUi(win: Window, $: Lookup): { check(trigger: CheckTrigger): Promise<void> } {
  const doc = win.document;
  const services: any = (win as any).Services ?? Services;
  const status = $('cert-status');
  const setStatus = (text: string) => { if (status) status.textContent = text; };
  const html = (tag: string, cls?: string, text?: string) => {
    const e = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const show = (c: CertInfo) => services.prompt.alert(win, t('prefs.certShowTitle', { host: `${c.host}:${c.port}` }),
    `${certDetails(c)}\n\n${c.der ? toPem(c.der) : ''}`);

  /** The dialog: true = trust, false = do not trust. "Show certificate" shows it and asks again. */
  const ask = (c: CertInfo): boolean => {
    const p = services.prompt;
    const flags = p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1 * p.BUTTON_TITLE_IS_STRING
      + p.BUTTON_POS_2 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1_DEFAULT;
    for (;;) {
      const button = p.confirmEx(win, t('prefs.certDialogTitle'), t('prefs.certDialogText', {
        host: `${c.host}:${c.port}`, reason: c.error ? t('prefs.certReason', { error: c.error }) : '', details: certDetails(c),
      }), flags, t('prefs.certTrust'), t('prefs.certDistrust'), t('prefs.certShow'), null, {});
      if (button === 2) {
        show(c);
        continue;
      }
      return button === 0;
    }
  };

  const render = () => {
    const box = $('certs');
    if (!box) return;
    const list = readCerts();
    if (!list.length) {
      box.replaceChildren(html('p', 'help', t('prefs.certsNone')));
      return;
    }
    box.replaceChildren(...list.map((c) => {
      const row = html('div', `cert ${c.trusted ? 'trusted' : 'untrusted'}`);
      const head = html('div', 'cert-head');
      const select = html('select') as HTMLSelectElement;
      for (const [value, label] of [['yes', t('prefs.certTrustedOpt')], ['no', t('prefs.certUntrustedOpt')]]) {
        const o = html('option', undefined, label) as HTMLOptionElement;
        o.value = value;
        select.append(o);
      }
      select.value = c.trusted ? 'yes' : 'no';
      select.addEventListener('change', () => {
        writeCerts(upsertCert(readCerts(), c, select.value === 'yes'));
        forgetServer(c.host, c.port);
        render();
      });
      const view = html('button', undefined, t('prefs.certShow'));
      view.addEventListener('click', () => show(c));
      const copy = html('button', undefined, t('prefs.certCopy'));
      copy.addEventListener('click', () => Zotero.Utilities.Internal.copyTextToClipboard(toPem(c.der)));
      const remove = html('button', undefined, t('prefs.certRemove'));
      remove.addEventListener('click', () => {
        writeCerts(removeCert(readCerts(), c));
        forgetServer(c.host, c.port);
        render();
      });
      head.append(html('span', 'cert-name', `${c.host}:${c.port} – ${c.commonName || c.subject}`), select, view, copy, remove);
      row.append(head, html('div', 'cert-details', certDetails(c)));
      return row;
    }));
  };

  /**
   * Checks the configured server. An unknown certificate opens the dialog when the server was just entered or the
   * button was clicked (on opening the settings only the status line tells); the button also asks again about a
   * certificate decided before.
   */
  const check = async (trigger: CheckTrigger) => {
    const interactive = trigger === 'button';
    const raw = String(getPref('baseUrl') || '').trim();
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      setStatus('');
      return;
    }
    if (u.protocol !== 'https:') {
      setStatus(interactive ? t('prefs.certNotHttps') : '');
      return;
    }
    try {
      assertAllowedUrl(u.href, parseAllowedHosts(getPref('allowedRemoteHosts')));
    } catch {
      // The certificate check itself contacts the server: only allowed hosts.
      setStatus(t('prefs.certHostNotAllowed'));
      return;
    }
    setStatus(t('prefs.certChecking'));
    const probe = await probeCertificate(u);
    if (probe.state === 'valid') {
      setStatus(t('prefs.certValid'));
      return;
    }
    if (probe.state === 'unreachable') {
      setStatus(t('prefs.certUnreachable'));
      return;
    }
    const known = findCert(readCerts(), probe.info);
    if (known && !interactive) {
      setStatus(t(known.trusted ? 'prefs.certTrusted' : 'prefs.certRefusedStatus'));
      return;
    }
    if (trigger === 'load') {
      setStatus(t('prefs.certUnknownStatus'));
      return;
    }
    const trusted = ask(probe.info);
    decideCertificate(probe.info, probe.cert, trusted);
    clearLimitsCache();
    setStatus(t(trusted ? 'prefs.certTrusted' : 'prefs.certRefusedStatus'));
    render();
  };

  $('cert-check')?.addEventListener('click', () => void check('button'));
  render();
  void check('load');
  return { check };
}
