import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaClient } from '../src/core/llm/ollama-client';
import { OpenAiClient } from '../src/core/llm/openai-client';
import { setLocale } from '../src/i18n';

setLocale('de');

type Call = { url: string; init: any };

/** Replaces fetch for one test: each call gets the next response; returns the calls made. */
async function withFetch(responses: (() => Response)[], fn: (calls: Call[]) => Promise<void>): Promise<void> {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unexpected fetch #${calls.length}`);
    return next();
  }) as any;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

/** A streaming body delivered in the given chunks (split mid-line on purpose by the callers). */
function stream(chunks: string[], status = 200): () => Response {
  return () => new Response(new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  }), { status });
}

const LOCAL = { baseUrl: 'http://127.0.0.1:11434', allowedRemoteHosts: [] };
const req = { model: 'm', messages: [{ role: 'user' as const, content: 'q' }], temperature: 0.2, maxTokens: 100 };

test('Ollama: streamed deltas across chunk borders, stops at done, never sends num_ctx', async () => {
  await withFetch([stream([
    '{"message":{"content":"Hal"},"done":false}\n{"message":{"con',
    'tent":"lo"},"done":false}\n{"done":true}\n{"message":{"content":"IGNORED"}}\n',
  ])], async (calls) => {
    const deltas: string[] = [];
    const out = await new OllamaClient(LOCAL).streamChat(req, (d) => deltas.push(d));
    assert.equal(out, 'Hallo');
    assert.deepEqual(deltas, ['Hal', 'lo']);
    assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(calls[0].init.redirect, 'error');
    const body = JSON.parse(calls[0].init.body);
    assert.equal('num_ctx' in body.options, false, 'num_ctx makes Ollama reload the model');
    assert.equal(body.options.num_predict, 100);
  });
});

test('Ollama: error line in the stream and HTTP error with JSON detail', async () => {
  await withFetch([stream(['{"message":{"content":"a"}}\n{"error":"out of memory"}\n'])], async () => {
    await assert.rejects(new OllamaClient(LOCAL).streamChat(req, () => {}), /out of memory/);
  });
  await withFetch([() => new Response('{"error":"model \\"m\\" not found"}', { status: 404 })], async () => {
    await assert.rejects(new OllamaClient(LOCAL).streamChat(req, () => {}), (e: any) => e.status === 404 && /HTTP 404: model "m" not found/.test(e.message));
  });
});

test('Ollama: model list and /api/show limits', async () => {
  await withFetch([
    () => Response.json({ models: [{ name: 'b' }, { name: 'a' }] }),
    () => Response.json({ parameters: 'num_ctx 32768\nnum_predict 4096', model_info: { 'qwen3.context_length': 131072 } }),
    () => Response.json({ models: [{ name: 'a:latest', model: 'a:latest', context_length: 65536 }] }),
  ], async (calls) => {
    const c = new OllamaClient(LOCAL);
    assert.deepEqual(await c.listModels(), ['a', 'b']);
    assert.deepEqual(await c.modelInfo('a'), { configuredContext: 32768, numPredict: 4096, maxContext: 131072, loadedContext: 65536 });
    assert.equal(calls[2].url, 'http://127.0.0.1:11434/api/ps');
    assert.equal(JSON.parse(calls[1].init.body).model, 'a');
  });
});

test('OpenAI: SSE deltas, [DONE] ends, bearer key, /v1 prefix kept', async () => {
  await withFetch([stream([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n: keep-alive\ndata: {"choi',
    'ces":[{"delta":{"content":" du"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"X"}}]}\n',
  ])], async (calls) => {
    const c = new OpenAiClient({ baseUrl: 'https://llm.ils.local/v1/', apiKey: 'sk', allowedRemoteHosts: ['llm.ils.local'] });
    assert.equal(await c.streamChat(req, () => {}), 'Hi du');
    assert.equal(calls[0].url, 'https://llm.ils.local/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk');
    assert.equal(JSON.parse(calls[0].init.body).max_tokens, 100);
  });
});

test('OpenAI: error event in the stream, HTTP error, context from /models', async () => {
  await withFetch([stream(['data: {"error":{"message":"rate limited"}}\n'])], async () => {
    await assert.rejects(new OpenAiClient(LOCAL).streamChat(req, () => {}), /rate limited/);
  });
  await withFetch([() => new Response('{"error":{"message":"bad key"}}', { status: 401 })], async () => {
    await assert.rejects(new OpenAiClient(LOCAL).listModels(), /HTTP 401: bad key/);
  });
  await withFetch([() => Response.json({ data: [{ id: 'm', max_model_len: 40960 }, { id: 'n' }] })], async () => {
    assert.deepEqual(await new OpenAiClient(LOCAL).modelInfo('m'), { configuredContext: 40960 });
  });
});

test('host guard and https rule stop the request before fetch', async () => {
  await withFetch([], async (calls) => {
    await assert.rejects(new OllamaClient({ baseUrl: 'http://evil.example', allowedRemoteHosts: [] }).listModels(), { code: 'HOST_REJECTED' });
    await assert.rejects(new OpenAiClient({ baseUrl: 'http://llm.ils.local/v1', apiKey: 'sk', allowedRemoteHosts: ['llm.ils.local'] }).listModels(), { code: 'HOST_REJECTED' });
    assert.equal(calls.length, 0);
  });
});
