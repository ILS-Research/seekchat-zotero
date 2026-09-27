/** Settings pane logic: fields <-> prefs, connection test and model list. */
import { createClient } from '../core/llm';
import { parseAllowedHosts } from '../core/host-guard';
import { DEFAULT_SYSTEM_PROMPT } from '../core/prompt';
import { getPref, readPrefs, setPref } from '../prefs';

const TEXT_PREFS = ['baseUrl', 'apiKey'];
const INT_PREFS = ['temperaturePercent', 'numCtx', 'contextChars', 'maxTokens', 'historyTurns'];

export function onPrefsLoad(win: Window): void {
  const doc = win.document;
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

  const prompt = $<HTMLTextAreaElement>('systemPrompt');
  if (prompt) {
    prompt.placeholder = DEFAULT_SYSTEM_PROMPT;
    prompt.value = String(getPref('systemPrompt') ?? '');
    prompt.addEventListener('change', () => setPref('systemPrompt', prompt.value.trim()));
  }

  const hosts = $<HTMLInputElement>('allowedRemoteHosts');
  const remoteStatus = $('remote-status');
  const showHosts = (list: string[]) => {
    if (remoteStatus) {
      remoteStatus.textContent = list.length
        ? `Freigegeben: ${list.join(', ')}. PDF-Text und Fragen an diese Hosts verlassen diesen Rechner.`
        : 'Keine entfernten Hosts freigegeben: SeekChat bleibt auf diesem Rechner.';
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
  model?.addEventListener('change', () => setPref('model', model.value));

  $('test')?.addEventListener('click', async () => {
    setStatus('Verbinde …');
    try {
      const names = await createClient(readPrefs()).listModels();
      fillModels(names);
      setStatus(names.length ? `Verbunden, ${names.length} Modell(e).` : 'Verbunden, aber der Server meldet keine Modelle.');
    } catch (e: any) {
      setStatus(`Fehler: ${e?.message || e}`);
    }
  });
}
