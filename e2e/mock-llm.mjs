// Minimal stand-in for Ollama's OpenAI interface in E2E tests: /v1/models, streaming /v1/chat/completions (SSE),
// read-only /api/show and /api/ps (the context window, as Ollama answers them), GET /__requests (all chat requests
// so far, tool calls with parsed arguments and tool results with tool_name for the replies below) and GET /__last.
// The native /api/chat is gone on purpose: SeekChat must never use it.
// Replies by request kind (from the system prompt): language detection -> "de",
// search terms -> JSON keyword list, library search plan -> JSON plan, pre-reading
// a book -> the first page of the document as passage, library chat ("<sources>")
// -> answer with source citations, anything else -> a fixed answer with a page citation.
// Tool chat (request with tools): "importiere" -> tool call import_references with
// IMPORT_REFS, after a tool result -> short answer quoting it, else a plain answer.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

const ANSWER = 'Laut Dokument fuehren Starkregenereignisse in Staedten zu Ueberflutungen [S. 2].';
const LIBRARY_ANSWER = 'Starkregen fuehrt zu Ueberflutungen [1, S. 2]; Waermeinseln erhoehen die Temperaturen [2, S. 27; 1].';
const KEYWORDS = '["Waermeinseln", "Hitzeinseln", "urban heat island"]';
const requests = [];
export const IMPORT_REFS = [
  {
    text: 'Kuttler, W. (2011): Klimawandel im urbanen Bereich. Teil 1, Wirkungen. Environmental Sciences Europe 23, S. 1-12.',
    itemType: 'journalArticle', title: 'Klimawandel im urbanen Bereich. Teil 1, Wirkungen', authors: ['Kuttler, Wilhelm'],
    date: '2011', publicationTitle: 'Environmental Sciences Europe', volume: '23', pages: '1-12',
  },
  {
    text: 'Umweltbundesamt (2019): Hitze in der Stadt – Strategien für eine klimaangepasste Stadtentwicklung. Dessau-Roßlau.',
    itemType: 'report', title: 'Hitze in der Stadt – Strategien für eine klimaangepasste Stadtentwicklung', authors: ['Umweltbundesamt'],
    date: '2019', publisher: 'Umweltbundesamt', place: 'Dessau-Roßlau', url: 'http://127.0.0.1:11434/hitze.pdf',
  },
];

/** One SSE event of /v1/chat/completions. */
function sse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function toolCall(res, name, args, text = 'Ich importiere die Quellen. ') {
  return toolCalls(res, [[name, args]], text);
}

/** Several tool calls in one answer, as real models do (e.g. six get_item at once). */
async function toolCalls(res, calls, text = '') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (text) sse(res, { choices: [{ delta: { role: 'assistant', content: text } }] });
  calls.forEach(([name, args], index) => sse(res, { choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
  sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  res.end('data: [DONE]\n\n');
}

async function stream(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const word of text.split(/(?<= )/)) {
    sse(res, { choices: [{ delta: { content: word } }] });
    await new Promise((r) => setTimeout(r, 15));
  }
  sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  res.end('data: [DONE]\n\n');
}

/** The request as the replies below read it: tool call arguments as objects, tool results with their tool's name. */
function normalized(body) {
  const names = {};
  const messages = (body.messages || []).map((m) => {
    if (m.tool_calls) {
      return { ...m, tool_calls: m.tool_calls.map((c) => {
        names[c.id] = c.function?.name;
        let args = c.function?.arguments;
        try { args = JSON.parse(args); } catch { /* kept as text */ }
        return { ...c, function: { ...c.function, arguments: args } };
      }) };
    }
    if (m.role === 'tool') return { ...m, tool_name: names[m.tool_call_id] };
    return m;
  });
  return { ...body, messages };
}

async function handle(req, res) {
  const json = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'GET' && req.url === '/v1/models') return json({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'library' }] });
  // Like a Modelfile without num_ctx: only the model's maximum context (auto limits: 80 % of it).
  if (req.method === 'POST' && req.url === '/api/show') {
    return json({ parameters: 'temperature 1', model_info: { 'mock.context_length': 20480, 'mock.rope.scaling.original_context_length': 4096 } });
  }
  // Linked PDF of a reference (tool chat import: "Find Full Text" downloads it).
  if (req.method === 'GET' && req.url === '/hitze.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    return res.end(fs.readFileSync('/fixtures/seekchat-test.pdf'));
  }
  // Loaded model with the window the server uses (no num_ctx is ever sent).
  if (req.method === 'GET' && req.url === '/api/ps') return json({ models: [{ name: 'mock-model', model: 'mock-model', context_length: 20480 }] });
  if (req.method === 'GET' && req.url === '/__requests') return json(requests);
  if (req.method === 'GET' && req.url === '/__last') return json(requests[requests.length - 1] ?? null);
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = normalized(JSON.parse(body));
    requests.push(parsed);
    const system = parsed.messages?.[0]?.content || '';
    const last = parsed.messages?.[parsed.messages.length - 1] || {};
    // Subagent (delegate_task), as the real model behaved in the live test. Default: one get_item for every item of
    // the package in ONE answer (no text), then a JSON list with one proposal per item. Words in the task:
    // "langsam" slow answers (stop button), "groß" reads every document (10 pages, one per round, so old results
    // get shortened), "vorrede" puts text around the fenced JSON, "felder" proposes fields Zotero names otherwise.
    if (system.includes('You are a subagent')) {
      const task = parsed.messages?.[1]?.content || '';
      if (/langsam/.test(task)) await new Promise((r) => setTimeout(r, 1500));
      const keys = [...task.matchAll(/^- (\w{8}):/gm)].map((m) => m[1]);
      const toolMsgs = parsed.messages.filter((m) => m.role === 'tool');
      const finalRound = !parsed.tools?.length;
      if (/groß/.test(task) && !finalRound && toolMsgs.length < keys.length) {
        return toolCall(res, 'read_document', { key: keys[toolMsgs.length], from_page: 1, to_page: 10 }, '');
      }
      if (last.role === 'user' && !finalRound) {
        return keys.length ? toolCalls(res, keys.map((key) => ['get_item', { key }])) : toolCall(res, 'list_tags', {}, '');
      }
      const proposals = keys.map((key) => ({ key, item_type: 'book', ...(/felder/.test(task) ? { fields: { year: '2020', degree: 'PhD' } } : {}), reason: 'mock' }));
      const json = '```json\n' + JSON.stringify(proposals) + '\n```';
      return stream(res, /vorrede/.test(task) ? `Hier ist mein Ergebnis für das Paket:\n\n${json}\n\nAlle Einträge geprüft.` : json);
    }
    if (parsed.tools?.length) {
      if (last.role === 'tool') {
        let result = {};
        try { result = JSON.parse(last.content || '{}'); } catch { /* error text */ }
        if (last.tool_name && last.tool_name !== 'import_references') {
          const n = result.total ?? result.selectedItems?.length ?? result.collections?.length ?? result.tags?.length ?? result.key ?? '?';
          return stream(res, `Ergebnis ${last.tool_name}: ${n}.`);
        }
        return stream(res, `Erledigt: ${result.saved ?? 0} gespeichert (${result.status || 'ok'}).`);
      }
      // "TOOL <name> <json>": call that tool with those arguments (library tool scenarios).
      const direct = (last.content || '').match(/^TOOL (\w+) (\{[\s\S]*\})$/);
      if (direct) return toolCall(res, direct[1], JSON.parse(direct[2]), '');
      // "TOOLS [[name, args], …]": several calls in one answer.
      const several = (last.content || '').match(/^TOOLS (\[[\s\S]*\])$/);
      if (several) return toolCalls(res, JSON.parse(several[1]));
      const offered = parsed.tools.map((x) => x.function?.name);
      if (/importiere/i.test(last.content || '') && offered.includes('import_references')) return toolCall(res, 'import_references', { references: IMPORT_REFS });
      return stream(res, 'Hallo aus dem Werkzeug-Chat.');
    }
    if (system.includes('Identify the language')) return stream(res, 'de');
    const question = parsed.messages?.[parsed.messages.length - 1]?.content || '';
    // Library plan: the question itself, its words as keywords (plus one that hits the long book, except for "Vulkane").
    if (system.includes('literature search')) {
      const q = (question.match(/New question: (.*)/) || [])[1] || '';
      const words = q.split(/[^\p{L}]+/u).filter((w) => w.length >= 4);
      const keywords = q.includes('Vulkane') ? words : [...words, 'Waermeinseln'];
      const plan = { question: q, queries: [q], keywords };
      // Follow-up about a page of source [1]: ask to load it (7e-2).
      const page = q.match(/Seite (\d+) von \[(\d+)\]/);
      if (page && system.includes('load_pages')) plan.load_pages = [{ source: Number(page[2]), pages: page[1] }];
      const doc = q.match(/Suche in \[(\d+)\] nach (.+)/);
      if (doc && system.includes('load_documents')) plan.load_documents = [{ source: Number(doc[1]), query: doc[2] }];
      // Follow-ups: search again only for a new topic, not to rework the result or load pages.
      if (system.includes('"search": true')) plan.search = !page && !doc && !/Fasse|zusammen|Tabelle/.test(q);
      return stream(res, JSON.stringify(plan));
    }
    // Pre-reading a book: nothing for "Vulkane", else the first page sent; slow for "Hitze" (skip/stop tests).
    if (system.includes('answer a question from one book')) {
      if (question.includes('Vulkane')) return stream(res, 'NO RELEVANT CONTENT');
      if (question.includes('Hitze')) await new Promise((r) => setTimeout(r, 4000));
      const page = (system.match(/\[Page (\d+)\]/) || [])[1] || '1';
      return stream(res, `[Page ${page}] Starkregen und Waermeinseln praegen das Stadtklima in dicht bebauten Quartieren.`);
    }
    if (system.includes('<sources>')) return stream(res, LIBRARY_ANSWER);
    return stream(res, system.includes('search terms') ? KEYWORDS : ANSWER);
  }
  res.writeHead(404);
  res.end();
}

http.createServer(handle).listen(11434, '127.0.0.1', () => console.log('mock LLM on 127.0.0.1:11434'));
// The same over https with a self-signed certificate (made by run-in-container.sh), for the certificate scenario.
if (fs.existsSync('/tmp/e2e-tls/cert.pem')) {
  https.createServer({ key: fs.readFileSync('/tmp/e2e-tls/key.pem'), cert: fs.readFileSync('/tmp/e2e-tls/cert.pem') }, handle)
    .listen(11443, '127.0.0.1', () => console.log('mock LLM on https://127.0.0.1:11443 (self-signed)'));
}
