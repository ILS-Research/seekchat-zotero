/** Settings pane logic: fields <-> prefs, connection test and model list. */
import { clearLimitsCache, resolveLimits } from '../core/limits';
import { formatCount } from '../core/context/fit';
import { createClient } from '../core/llm';
import { parseAllowedHosts } from '../core/host-guard';
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
    input.addEventListener('change', () => setPref(key, input.value.trim()));
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

  const invalidCerts = $<HTMLInputElement>('allowInvalidCerts');
  if (invalidCerts) {
    invalidCerts.checked = getPref('allowInvalidCerts') === true;
    invalidCerts.addEventListener('change', () => {
      setPref('allowInvalidCerts', invalidCerts.checked);
      clearLimitsCache();
    });
  }

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
