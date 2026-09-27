// Minimal Ollama stand-in for E2E tests: /api/tags, streaming /api/chat,
// GET /__requests (all chat requests so far) and GET /__last.
// A request whose system prompt asks for search terms ("Suchbegriffe") gets a
// JSON keyword list; every other request gets a fixed answer with a citation.
import http from 'node:http';

const ANSWER = 'Laut Dokument fuehren Starkregenereignisse in Staedten zu Ueberflutungen [S. 2].';
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
  if (req.method === 'GET' && req.url === '/__requests') return json(requests);
  if (req.method === 'GET' && req.url === '/__last') return json(requests[requests.length - 1] ?? null);
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const isKeywordRequest = parsed.messages?.[0]?.content?.includes('Suchbegriffe');
    return stream(res, isKeywordRequest ? KEYWORDS : ANSWER);
  }
  res.writeHead(404);
  res.end();
});
server.listen(11434, '127.0.0.1', () => console.log('mock LLM on 127.0.0.1:11434'));
