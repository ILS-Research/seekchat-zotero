import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, OpenAiClient, thinkingFields } from '../src/core/llm/openai-client';
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

test('only the OpenAI interface: a bare server gets /v1, a URL with a path is kept; never num_ctx', async () => {
  assert.equal(apiBase('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1');
  assert.equal(apiBase('https://ollama.ils.local/'), 'https://ollama.ils.local/v1');
  assert.equal(apiBase('https://llm.ils.local/v1/'), 'https://llm.ils.local/v1');
  assert.equal(apiBase('https://proxy.ils.local/openai/v1'), 'https://proxy.ils.local/openai/v1');
  await withFetch([stream(['data: {"choices":[{"delta":{"content":"Hal"}}]}\n\ndata: {"choi', 'ces":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'])], async (calls) => {
    const deltas: string[] = [];
    assert.equal(await new OpenAiClient(LOCAL).streamChat(req, (d) => deltas.push(d)), 'Hallo');
    assert.deepEqual(deltas, ['Hal', 'lo']);
    assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(calls[0].init.redirect, 'error');
    const body = JSON.parse(calls[0].init.body);
    assert.ok(!JSON.stringify(body).includes('num_ctx') && !('options' in body), 'no context size, no Ollama options');
    assert.equal(body.max_tokens, 100);
  });
});

test('window: /v1/models first (vLLM max_model_len), else Ollama read-only via /api/show + /api/ps, else nothing', async () => {
  await withFetch([() => Response.json({ data: [{ id: 'm', max_model_len: 40960 }] })], async (calls) => {
    assert.deepEqual(await new OpenAiClient(LOCAL).modelInfo('m'), { configuredContext: 40960 });
    assert.equal(calls.length, 1);
  });
  await withFetch([
    () => Response.json({ data: [{ id: 'a' }] }),
    () => Response.json({ parameters: 'num_ctx 32768\nnum_predict 4096', model_info: { 'qwen3.context_length': 131072 } }),
    () => Response.json({ models: [{ name: 'a:latest', model: 'a:latest', context_length: 65536 }] }),
  ], async (calls) => {
    const c = new OpenAiClient({ ...LOCAL, baseUrl: 'http://127.0.0.1:11434/v1' });
    assert.deepEqual(await c.modelInfo('a'), { configuredContext: 32768, numPredict: 4096, maxContext: 131072, ollama: true, loadedContext: 65536 });
    assert.deepEqual(calls.map((x) => x.url), ['http://127.0.0.1:11434/v1/models', 'http://127.0.0.1:11434/api/show', 'http://127.0.0.1:11434/api/ps']);
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(JSON.parse(calls[1].init.body).model, 'a');
  });
  await withFetch([() => Response.json({ data: [{ id: 'a' }] }), () => new Response('not found', { status: 404 })], async () => {
    assert.deepEqual(await new OpenAiClient(LOCAL).modelInfo('a'), {});
  });
});

test('thinking switch: Ollama reasoning_effort and template kwargs; dropped once on HTTP 400 about it', async () => {
  assert.deepEqual(thinkingFields(undefined), {});
  assert.deepEqual(thinkingFields(false), { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(thinkingFields(true), { chat_template_kwargs: { enable_thinking: true } });
  const ok = stream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n']);
  const think = { ...req, model: 'nothink-model', think: false };
  await withFetch([() => new Response('{"error":{"message":"unsupported reasoning_effort"}}', { status: 400 }), ok, ok], async (calls) => {
    const c = new OpenAiClient(LOCAL);
    assert.equal(await c.streamChat(think, () => {}), 'hi');
    assert.equal(await c.streamChat(think, () => {}), 'hi');
    const bodies = calls.map((x) => JSON.parse(x.init.body));
    assert.equal(bodies[0].reasoning_effort, 'none');
    assert.ok(!('reasoning_effort' in bodies[1]) && !('reasoning_effort' in bodies[2]), 'remembered for the server and model');
  });
  await withFetch([() => new Response('{"error":{"message":"model qwen3-thinking not found"}}', { status: 404 })], async (calls) => {
    await assert.rejects(new OpenAiClient(LOCAL).streamChat({ ...req, model: 'qwen3-thinking', think: false }, () => {}), /HTTP 404/);
    assert.equal(calls.length, 1, 'no retry');
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
    await assert.rejects(new OpenAiClient({ baseUrl: 'http://evil.example', allowedRemoteHosts: [] }).listModels(), { code: 'HOST_REJECTED' });
    await assert.rejects(new OpenAiClient({ baseUrl: 'http://llm.ils.local/v1', apiKey: 'sk', allowedRemoteHosts: ['llm.ils.local'] }).listModels(), { code: 'HOST_REJECTED' });
    assert.equal(calls.length, 0);
  });
});
