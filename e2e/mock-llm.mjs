// Minimal Ollama stand-in for E2E tests: /api/tags, streaming /api/chat,
// GET /__requests (all chat requests so far) and GET /__last.
// Replies by request kind (from the system prompt): language detection -> "de",
// search terms -> JSON keyword list, library search plan -> JSON plan, pre-reading
// a book -> the first page of the document as passage, library chat ("<sources>")
// -> answer with source citations, anything else -> a fixed answer with a page citation.
import http from 'node:http';

const ANSWER = 'Laut Dokument fuehren Starkregenereignisse in Staedten zu Ueberflutungen [S. 2].';
const LIBRARY_ANSWER = 'Starkregen fuehrt zu Ueberflutungen [1, S. 2]; Waermeinseln erhoehen die Temperaturen [2, S. 27; 1].';
const KEYWORDS = '["Waermeinseln", "Hitzeinseln", "urban heat island"]';
const requests = [];

async function stream(res, text) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const word of text.split(/(?<= )/)) {
    res.write(JSON.stringify({ message: { role: 'assistant', content: word }, done: false }) + '\n');
    await new Promise((r) => setTimeout(r, 15));
  }
  res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
}

const server = http.createServer(async (req, res) => {
  const json = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'GET' && req.url === '/api/tags') return json({ models: [{ name: 'mock-model' }] });
  // Like a Modelfile without num_ctx: only the model's maximum context (auto limits: 80 % of it).
  if (req.method === 'POST' && req.url === '/api/show') {
    return json({ parameters: 'temperature 1', model_info: { 'mock.context_length': 20480, 'mock.rope.scaling.original_context_length': 4096 } });
  }
  if (req.method === 'GET' && req.url === '/__requests') return json(requests);
  if (req.method === 'GET' && req.url === '/__last') return json(requests[requests.length - 1] ?? null);
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const system = parsed.messages?.[0]?.content || '';
    if (system.includes('Identify the language')) return stream(res, 'de');
    const question = parsed.messages?.[parsed.messages.length - 1]?.content || '';
    // Library plan: the question itself, its words as keywords (plus one that hits the long book, except for "Vulkane").
    if (system.includes('literature search')) {
      const q = (question.match(/New question: (.*)/) || [])[1] || '';
      const words = q.split(/[^\p{L}]+/u).filter((w) => w.length >= 4);
      const keywords = q.includes('Vulkane') ? words : [...words, 'Waermeinseln'];
      const plan = { question: q, queries: [q], keywords };
      // Follow-up about a page of source [1]: ask to load it (7e-2).
      const page = q.match(/Seite (\d+) von \[1\]/);
      if (page && system.includes('load_pages')) plan.load_pages = [{ source: 1, pages: page[1] }];
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
});
server.listen(11434, '127.0.0.1', () => console.log('mock LLM on 127.0.0.1:11434'));
