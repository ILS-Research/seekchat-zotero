import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../src/i18n';
import {
  ollamaMessages, openAiMessages, parseOllamaLine, parseSseLine, parseToolArguments, ToolCallAccumulator,
} from '../src/core/llm/stream-parsers';
import { OllamaClient } from '../src/core/llm/ollama-client';
import { OpenAiClient } from '../src/core/llm/openai-client';
import type { ChatRequest, ChatResult, LlmClient } from '../src/core/llm/types';
import {
  cleanDOI, cleanISBN, fieldIdentifier, trustedTextIdentifiers, itemLabel, itemTypeOf, parseCreator, referencesFromArgs, referenceToItemJSON, sameTitle,
} from '../src/core/tools/import-references/reference';
import { resolveWithChain, type ReferenceResolver } from '../src/core/tools/import-references/resolvers';
import { importReferencesTool, type ImportDeps } from '../src/core/tools/import-references/tool';
import { runToolLoop } from '../src/core/tools/loop';
import { ToolRegistry } from '../src/core/tools/registry';
import type { Tool, ToolContext } from '../src/core/tools/types';
import type { ToolRun, Turn } from '../src/core/turn';
import { toolErrorMessage } from '../src/core/tools/session';
import { effectiveOptions, isToolEnabled, setToolEnabled, setToolOption, storedOption } from '../src/core/tools/settings';
import { findRefsResolver, mergeParsed } from '../src/core/tools/import-references/findrefs-resolver';
import { ZOTERO_DEPS } from '../src/core/tools/import-references/tool';

setLocale('de');

// --- stream parsers and wire formats ---

test('Ollama line with tool calls: arguments as object, no id', () => {
  const ev = parseOllamaLine(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'import_references', arguments: { references: [{ text: 'x' }] } } }] }, done: false }));
  assert.deepEqual(ev?.toolCalls, [{ id: '', name: 'import_references', arguments: { references: [{ text: 'x' }] } }]);
});

test('OpenAI tool call fragments are joined per index', () => {
  const acc = new ToolCallAccumulator();
  const lines = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'import_', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'references', arguments: '{"refer' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ences":[]}' } }, { index: 1, id: 'c2', function: { name: 'other', arguments: 'nope' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  let done = false;
  for (const l of lines) {
    const ev = parseSseLine(`data: ${JSON.stringify(l)}`)!;
    if (ev.toolDeltas) acc.push(ev.toolDeltas);
    done ||= !!ev.done;
  }
  assert.ok(done);
  assert.deepEqual(acc.result(), [
    { id: 'c1', name: 'import_references', arguments: { references: [] } },
    { id: 'c2', name: 'other', arguments: { _raw: 'nope' } },
  ]);
});

test('tool arguments: objects pass, JSON strings are parsed, garbage is kept raw', () => {
  assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments('[1]'), { _raw: '[1]' });
});

test('messages with tool calls and results in both wire formats', () => {
  const msgs = [
    { role: 'user' as const, content: 'q' },
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1 } }] },
    { role: 'tool' as const, content: 'ok', toolCallId: 'c1', toolName: 't' },
  ];
  assert.deepEqual(ollamaMessages(msgs), [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 't', arguments: { a: 1 } } }] },
    { role: 'tool', content: 'ok', tool_name: 't' },
  ]);
  assert.deepEqual(openAiMessages(msgs), [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":1}' } }] },
    { role: 'tool', content: 'ok', tool_call_id: 'c1' },
  ]);
});

async function withFetch(body: string, fn: (calls: any[]) => Promise<void>): Promise<void> {
  const calls: any[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }));
  }) as any;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

const LOCAL = { baseUrl: 'http://127.0.0.1:11434', allowedRemoteHosts: [] };
const TOOL = { name: 't', description: 'd', parameters: { type: 'object', properties: {} } };

test('Ollama client sends tools and returns numbered tool calls', async () => {
  const body = [
    { message: { content: 'Ok. ' }, done: false },
    { message: { content: '', tool_calls: [{ function: { name: 't', arguments: { a: 1 } } }] }, done: false },
    { message: { content: '', tool_calls: [{ function: { name: 't', arguments: { a: 2 } } }] }, done: false },
    { message: { content: '' }, done: true },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n';
  await withFetch(body, async (calls) => {
    const out = await new OllamaClient(LOCAL).streamTurn({ model: 'm', messages: [{ role: 'user', content: 'q' }], temperature: 0, maxTokens: 10, tools: [TOOL] }, () => {});
    assert.equal(out.text, 'Ok. ');
    assert.deepEqual(out.toolCalls.map((c) => [c.id, c.arguments.a]), [['call_0', 1], ['call_1', 2]]);
    assert.deepEqual(calls[0].body.tools, [{ type: 'function', function: TOOL }]);
  });
});

test('OpenAI client without tools sends no tools field', async () => {
  const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  await withFetch(body, async (calls) => {
    const out = await new OpenAiClient(LOCAL).streamTurn({ model: 'm', messages: [{ role: 'user', content: 'q' }], temperature: 0, maxTokens: 10 }, () => {});
    assert.deepEqual(out, { text: 'hi', toolCalls: [] });
    assert.equal('tools' in calls[0].body, false);
  });
});

// --- references ---

test('item type from the model name or the fields', () => {
  assert.equal(itemTypeOf({ itemType: 'Journal Article' }), 'journalArticle');
  assert.equal(itemTypeOf({ itemType: 'inproceedings' }), 'conferencePaper');
  assert.equal(itemTypeOf({ containerTitle: 'Handbuch' }), 'bookSection');
  assert.equal(itemTypeOf({ publisher: 'oekom' }), 'book');
  assert.equal(itemTypeOf({ url: 'https://x.de' }), 'webpage');
  assert.equal(itemTypeOf({}), 'document');
});

test('creators: "Last, First", "First Last", particles, organisations', () => {
  assert.deepEqual(parseCreator('Müller, Hans', 'author'), { creatorType: 'author', lastName: 'Müller', firstName: 'Hans' });
  assert.deepEqual(parseCreator('Hans Peter Müller', 'author'), { creatorType: 'author', firstName: 'Hans Peter', lastName: 'Müller' });
  assert.deepEqual(parseCreator('Ludwig van Beethoven', 'author'), { creatorType: 'author', firstName: 'Ludwig', lastName: 'van Beethoven' });
  assert.deepEqual(parseCreator('Umweltbundesamt', 'author'), { creatorType: 'author', lastName: 'Umweltbundesamt', fieldMode: 1 });
  assert.deepEqual(parseCreator('Deutsches Institut für Urbanistik', 'author'), { creatorType: 'author', lastName: 'Deutsches Institut für Urbanistik', fieldMode: 1 });
  assert.equal(parseCreator('  ', 'author'), null);
});

test('identifiers: DOI from URL, ISBN only with a valid check digit', () => {
  assert.equal(cleanDOI('https://doi.org/10.1016/j.uclim.2020.100123.'), '10.1016/j.uclim.2020.100123');
  assert.equal(cleanISBN('ISBN 978-3-86581-123-4'), undefined);
  assert.equal(cleanISBN('978-3-16-148410-0'), '9783161484100');
  assert.equal(cleanISBN('3-16-148410-X'), '316148410X');
  assert.deepEqual(fieldIdentifier({ url: 'https://doi.org/10.5194/hess-1-2' }), { DOI: '10.5194/hess-1-2' });
  assert.deepEqual(fieldIdentifier({ ISBN: '978-3-16-148410-0' }), { ISBN: '9783161484100' });
  assert.equal(fieldIdentifier({ text: 'no ids' }), undefined);
});

test('PMIDs from the text only when labelled (Zotero takes bare numbers for PMIDs)', () => {
  const text = 'Kuttler (2011): Klima. Env. Sci. Eur. 23, S. 1-12. PMID: 21234567';
  assert.deepEqual(trustedTextIdentifiers(text, [{ PMID: '1' }, { PMID: '21234567' }, { DOI: '10.1/x' }]), [{ PMID: '21234567' }, { DOI: '10.1/x' }]);
});

test('reference to item JSON: type-specific fields, editors, label', () => {
  const item = referenceToItemJSON({
    text: 'Müller, H.; Schmidt, A. (2020): Starkregen. In: Meier, K. (Hg.): Handbuch Stadtklima. Berlin: Springer, S. 10-20.',
    itemType: 'bookSection', title: 'Starkregen', authors: ['Müller, H.', 'Schmidt, A.'], editors: ['Meier, K.'],
    date: '2020', containerTitle: 'Handbuch Stadtklima', publisher: 'Springer', place: 'Berlin', pages: '10-20',
  });
  assert.equal(item.itemType, 'bookSection');
  assert.equal(item.bookTitle, 'Handbuch Stadtklima');
  assert.equal(item.publisher, 'Springer');
  assert.deepEqual(item.creators!.map((c) => [c.creatorType, c.lastName]), [['author', 'Müller'], ['author', 'Schmidt'], ['editor', 'Meier']]);
  assert.equal(itemLabel(item), 'Müller, Schmidt (2020): Starkregen');
  const report = referenceToItemJSON({ text: 'x', itemType: 'report', title: 'Hitze', publisher: 'UBA' });
  assert.equal(report.institution, 'UBA');
  assert.equal(referenceToItemJSON({ text: 'Nur Text' }).title, 'Nur Text');
});

test('references from tool arguments: strings, objects, authors as one string', () => {
  const refs = referencesFromArgs({ references: ['A. B. (2020) Titel', { title: 'T', authors: 'Müller, H.; Meier, K.' }, {}, null] });
  assert.equal(refs.length, 2);
  assert.equal(refs[0].text, 'A. B. (2020) Titel');
  assert.deepEqual(refs[1].authors, ['Müller, H.', 'Meier, K.']);
  assert.deepEqual(referencesFromArgs({}), []);
});

test('same title: word overlap, accents and case ignored', () => {
  assert.ok(sameTitle('Urbane Hitzeinseln in Europa', 'urbane hitzeinseln in europa'));
  assert.ok(!sameTitle('Urbane Hitzeinseln in Europa', 'Starkregen in Städten'));
});

// --- resolver chain ---

test('import: failed steps are shown only when the item comes from the text alone', async () => {
  const { deps } = fakeDeps();
  deps.resolvers = () => [
    { id: 'zotero-reference', resolve: async () => { throw new Error('HTTP 404'); } },
    { id: 'identifier', resolve: async (r) => (r.DOI ? { item: { itemType: 'report', title: 'Found' }, via: 'identifier', detail: `DOI ${r.DOI}` } : null) },
    { id: 'text', resolve: async (r) => ({ item: referenceToItemJSON(r), via: 'text' }) },
  ];
  const { run, ctx } = toolContext(() => false);
  await importReferencesTool(deps).run({ references: [{ text: 'A', DOI: '10.2312/lis.14.01' }, { text: 'B', title: 'B' }] }, ctx);
  assert.equal(run.items![0].detail, 'gefunden über DOI 10.2312/lis.14.01');
  assert.match(run.items![1].detail!, /nur aus dem Quellentext.*Suche fehlgeschlagen: zotero-reference: HTTP 404/);
});

test('chain: first resolver with a result wins, failures are collected', async () => {
  const failing: ReferenceResolver = { id: 'a', resolve: async () => { throw new Error('HTTP 500'); } };
  const none: ReferenceResolver = { id: 'b', resolve: async () => null };
  const text: ReferenceResolver = { id: 'c', resolve: async (r) => ({ item: { itemType: 'document', title: r.text }, via: 'text' }) };
  const out = await resolveWithChain({ text: 'T' }, [failing, none, text], new AbortController().signal);
  assert.equal(out.resolved?.item.title, 'T');
  assert.deepEqual(out.failures, ['a: HTTP 500']);
});

// --- loop ---

/** Model stand-in: replies in order; records the requests. */
function scriptedClient(replies: ChatResult[]): LlmClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    listModels: async () => [],
    modelInfo: async () => ({}),
    streamChat: async () => '',
    async streamTurn(req, onDelta) {
      requests.push({ ...req, messages: [...req.messages] });
      const r = replies.shift() || { text: 'end', toolCalls: [] };
      if (r.text) onDelta(r.text);
      return r;
    },
  };
}

function loopContext(answer: Turn) {
  return (run: ToolRun): ToolContext => ({
    target: { libraryID: 1, label: 'Meine Bibliothek' }, options: {}, signal: new AbortController().signal, run, update: () => {}, confirm: async () => true,
  });
}

test('loop: tool call, result back to the model, final answer', async () => {
  const echo: Tool = { spec: TOOL, label: () => 'Echo', description: () => '', title: () => 'Echo', run: async (args) => `got ${args.a}` };
  const client = scriptedClient([
    { text: '<think>hm</think>Moment.', toolCalls: [{ id: 'c1', name: 't', arguments: { a: 7 } }] },
    { text: 'Fertig.', toolCalls: [] },
  ]);
  const answer: Turn = { role: 'assistant', content: '', pending: true };
  await runToolLoop({ client, request: { model: 'm', temperature: 0, maxTokens: 10 }, messages: [{ role: 'user', content: 'q' }], registry: new ToolRegistry([echo]), answer, notify: () => {}, context: loopContext(answer) });
  assert.equal(answer.content, 'Moment.\n\nFertig.');
  assert.deepEqual(answer.toolRuns!.map((r) => [r.title, r.state]), [['Echo', 'done']]);
  const second = client.requests[1].messages;
  assert.deepEqual(second.slice(-2).map((m) => [m.role, m.content]), [['assistant', 'Moment.'], ['tool', 'got 7']]);
  assert.ok(client.requests[1].tools?.length);
});

test('loop: unknown tool and broken arguments go back as errors; rounds are limited', async () => {
  const client = scriptedClient([
    { text: '', toolCalls: [{ id: 'c1', name: 'nope', arguments: {} }] },
    { text: '', toolCalls: [{ id: 'c2', name: 't', arguments: { _raw: '{' } }] },
    { text: 'last', toolCalls: [{ id: 'c3', name: 't', arguments: {} }] },
  ]);
  const answer: Turn = { role: 'assistant', content: '', pending: true };
  const tool: Tool = { spec: TOOL, label: () => 'T', description: () => '', title: () => 'T', run: async () => 'ok' };
  await runToolLoop({ client, request: { model: 'm', temperature: 0, maxTokens: 10 }, messages: [], registry: new ToolRegistry([tool]), answer, notify: () => {}, context: loopContext(answer), maxRounds: 2 });
  assert.deepEqual(answer.toolRuns!.map((r) => r.state), ['error', 'error']);
  assert.match(client.requests[1].messages.at(-1)!.content, /no tool named "nope"/);
  assert.match(client.requests[2].messages.at(-2)!.content, /not valid JSON/);
  assert.equal(client.requests[2].tools, undefined, 'last round without tools');
  assert.deepEqual([client.requests[2].messages.at(-1)!.role, /cannot call tools any more/.test(client.requests[2].messages.at(-1)!.content)], ['user', true], 'last round asks for the answer');
  assert.equal(answer.content, 'last');
});

test('unsupported tool calling gets a hint', () => {
  assert.match(toolErrorMessage(new Error('HTTP 400: registry.ollama.ai/library/gemma2 does not support tools')), /Tool-Unterstützung/);
  assert.equal(toolErrorMessage(new Error('HTTP 500')), 'HTTP 500');
});

// --- import tool with fake Zotero ---

function fakeDeps(opts: { duplicateTitle?: string } = {}) {
  const saved: string[] = [];
  const deps: ImportDeps = {
    resolvers: () => [
      { id: 'identifier', resolve: async (r) => (r.DOI ? { item: { itemType: 'journalArticle', title: `Found ${r.DOI}`, creators: [] }, via: 'identifier', detail: `DOI ${r.DOI}` } : null) },
      { id: 'text', resolve: async (r) => ({ item: referenceToItemJSON(r), via: 'text' }) },
    ],
    findDuplicate: async (item) => (item.title === opts.duplicateTitle ? { id: 99 } : null),
    save: async (resolved) => {
      saved.push(String(resolved.item.title));
      return { id: 100 + saved.length, getField: () => String(resolved.item.title) };
    },
    attachPdf: async (item: any) => (item.id === 101 ? 'attached' : 'none'),
  };
  return { deps, saved };
}

function toolContext(confirm: (run: ToolRun) => boolean) {
  const run: ToolRun = { id: 'c1', name: 'import_references', title: '', state: 'running' };
  const ctx: ToolContext = {
    target: { libraryID: 1, collectionID: 5, label: 'Sammlung „Klima“' }, options: {}, signal: new AbortController().signal, run, update: () => {},
    confirm: async () => { run.state = 'confirm'; const ok = confirm(run); run.state = 'running'; return ok; },
  };
  return { run, ctx };
}

test('import: preview with duplicate unchecked, saves only checked items, reports to the model', async () => {
  const { deps, saved } = fakeDeps({ duplicateTitle: 'Alt' });
  const tool = importReferencesTool(deps);
  const { run, ctx } = toolContext((r) => {
    assert.deepEqual(r.items!.map((i) => [i.badge, i.checked]), [['gefunden', true], ['vorhanden', false], ['Text', true]]);
    r.items![2].checked = false;
    return true;
  });
  const args = { references: [{ text: 'X, doi 10.1/x', DOI: '10.1/x' }, { text: 'Alt', title: 'Alt' }, { text: 'Neu', title: 'Neu' }] };
  assert.equal(tool.title(args), '3 Quellen importieren');
  const out = JSON.parse(await tool.run(args, ctx));
  assert.deepEqual(saved, ['Found 10.1/x']);
  assert.equal(out.saved, 1);
  assert.deepEqual(out.references.map((r: any) => r.status), ['imported', 'already in library, not imported', 'skipped by the user']);
  assert.equal(run.state, 'done');
  assert.equal(run.items![0].itemID, 101);
  assert.equal(run.items![1].itemID, 99, 'duplicate links to the existing item');
  assert.equal(run.status, '1 Eintrag in Sammlung „Klima“ gespeichert. 1 PDF angehängt.');
  assert.match(run.items![0].detail!, /PDF angehängt$/);
  assert.equal(out.pdfsAttached, 1);
  assert.equal(out.references[0].pdf, 'attached');
});

test('import: option pdf "off" looks for no PDF', async () => {
  const { deps } = fakeDeps();
  let asked = 0;
  deps.attachPdf = async () => { asked++; return 'attached'; };
  const { run, ctx } = toolContext(() => true);
  ctx.options = { pdf: 'off' };
  const out = JSON.parse(await importReferencesTool(deps).run({ references: [{ text: 'A', title: 'A' }] }, ctx));
  assert.equal(asked, 0);
  assert.equal(out.saved, 1);
  assert.equal(run.status, '1 Eintrag in Sammlung „Klima“ gespeichert.');
});

test('import: cancelled preview saves nothing', async () => {
  const { deps, saved } = fakeDeps();
  const { run, ctx } = toolContext(() => false);
  const out = JSON.parse(await importReferencesTool(deps).run({ references: [{ text: 'A' }] }, ctx));
  assert.equal(out.saved, 0);
  assert.equal(saved.length, 0);
  assert.equal(run.state, 'cancelled');
});

test('import: no references is an error for the model', async () => {
  const { deps } = fakeDeps();
  const { ctx } = toolContext(() => true);
  assert.match(await importReferencesTool(deps).run({ references: [] }, ctx), /^Error: no references/);
});

// --- settings and the zotero-reference resolver (Zotero stubbed) ---

function stubZotero(api?: any): Map<string, any> {
  const prefs = new Map<string, any>();
  (globalThis as any).Zotero = {
    Prefs: { get: (k: string) => prefs.get(k), set: (k: string, v: any) => prefs.set(k, v) },
    debug: () => {},
    ...(api ? { FindOnlineReferences: { api } } : {}),
  };
  return prefs;
}

test('settings: tools on by default, switched off by pref; unavailable choice falls back to the default', () => {
  stubZotero();
  const tool = importReferencesTool(fakeDeps().deps);
  assert.ok(isToolEnabled('import_references'));
  setToolEnabled('import_references', false);
  assert.ok(!isToolEnabled('import_references'));
  setToolEnabled('import_references', true);
  assert.ok(isToolEnabled('import_references'));
  setToolOption(tool, 'parser', 'zotero-reference');
  assert.equal(storedOption(tool, tool.options![0]), 'zotero-reference');
  assert.deepEqual(effectiveOptions(tool), { parser: 'zotero', pdf: 'find' }, 'plugin missing');
  stubZotero({ version: 1, parseReference: () => ({}), lookup: async () => undefined }).set('seekchat.tools.import_references.parser', 'zotero-reference');
  assert.deepEqual(effectiveOptions(tool), { parser: 'zotero-reference', pdf: 'find' });
  assert.deepEqual(ZOTERO_DEPS.resolvers({ parser: 'zotero-reference' }).map((r) => r.id), ['zotero-reference', 'identifier', 'url', 'text']);
  assert.deepEqual(ZOTERO_DEPS.resolvers({ parser: 'zotero' }).map((r) => r.id), ['identifier', 'url', 'text']);
  delete (globalThis as any).Zotero;
});

test('zotero-reference resolver: model fields win, DOI found -> Zotero lookup, else item from the record', async () => {
  const parsed = { text: 't', title: 'Parsed title', authors: ['P'], year: '1999', identifiers: {} };
  assert.deepEqual(mergeParsed(parsed, { title: 'Model title', DOI: 'doi:10.1000/a' }).identifiers, { DOI: '10.1000/a' });
  assert.equal(mergeParsed(parsed, {}).title, 'Parsed title');
  let looked: any = null as any;
  const identifier: ReferenceResolver = { id: 'identifier', resolve: async (r) => (r.DOI ? { item: { itemType: 'journalArticle', title: 'Full' }, via: 'identifier', detail: `DOI ${r.DOI}` } : null) };
  stubZotero({
    version: 1,
    parseReference: (text: string) => ({ ...parsed, text }),
    lookup: async (ref: any) => { looked = ref; return ref.title === 'With DOI' ? { title: 'X', authors: [], identifiers: { DOI: '10.2/b' }, source: 'crossref' } : { title: 'Record', authors: ['Doe, Jane'], year: '2001', identifiers: {}, venue: 'J', type: 'journalArticle', source: 'openalex' }; },
  });
  const r = findRefsResolver(identifier);
  // A reference with an identifier is left to Zotero (all registration agencies), without asking the plugin.
  assert.equal(await r.resolve({ text: 'x', title: 'With DOI', DOI: '10.2312/lis.14.01' }, new AbortController().signal), null);
  assert.equal(looked, null);
  const a = await r.resolve({ text: 'x', title: 'With DOI' }, new AbortController().signal);
  assert.deepEqual([a?.via, a?.item.title, a?.detail], ['zotero-reference', 'Full', 'Find Online References (crossref): DOI 10.2/b']);
  const b = await r.resolve({ text: 'y' }, new AbortController().signal);
  assert.equal(looked!.title, 'Parsed title');
  assert.deepEqual([b?.item.title, b?.item.date, b?.item.publicationTitle, b?.detail], ['Record', '2001', 'J', 'Find Online References (openalex)']);
  delete (globalThis as any).Zotero;
  await assert.rejects(r.resolve({ text: 'z' }, new AbortController().signal), /not installed/);
});

// --- tool chat: the conversation is kept inside the context window ---

test('fitToContext keeps system prompts, drops history, then cuts the question hard', async () => {
  const { fitToContext, MIN_QUESTION_CHARS } = await import('../src/core/tools/agent/plan');
  const system = 'S'.repeat(1000);
  const messages: import('../src/core/llm/types').ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: 'old question '.repeat(50) },
    { role: 'assistant', content: 'old answer '.repeat(50) },
    { role: 'user', content: 'Q'.repeat(5000) },
  ];
  fitToContext(messages, 2000, 3);
  assert.equal(messages[0].content, system);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.startsWith('Q'.repeat(MIN_QUESTION_CHARS)));
  assert.ok(messages[1].content.length < 1100, String(messages[1].content.length));
  assert.match(messages[1].content, /question cut/);
});

test('fitToContext changes nothing that fits, and at last shortens even the newest tool results', async () => {
  const { fitToContext } = await import('../src/core/tools/agent/plan');
  const small: import('../src/core/llm/types').ChatMessage[] = [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }];
  fitToContext(small, 1000, 1);
  assert.deepEqual(small, [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }]);
  const big: import('../src/core/llm/types').ChatMessage[] = [
    { role: 'system', content: 'S'.repeat(500) },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_document', arguments: {} }] },
    { role: 'tool', content: 'T'.repeat(20000), toolCallId: 'c1' },
  ];
  fitToContext(big, 2000, 1);
  assert.equal(big[0].content.length, 500);
  assert.ok(big[3].content.length < 1000);
});
