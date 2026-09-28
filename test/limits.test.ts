import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSource, limitsFromContext } from '../src/core/limits';
import { parseOllamaShow } from '../src/core/llm/ollama-client';
import { setLocale } from '../src/i18n';

// The expectations below are the German UI texts; English is covered in i18n.test.ts.
setLocale('de');

test('ollama /api/show: num_ctx and num_predict from the Modelfile, maximum from model_info', () => {
  assert.deepEqual(parseOllamaShow({
    parameters: 'min_p                          0\nnum_ctx                        131072\nnum_predict                    24576\ntop_k 20',
    model_info: { 'qwen35.context_length': 262144 },
  }), { configuredContext: 131072, numPredict: 24576, maxContext: 262144 });
  assert.deepEqual(parseOllamaShow({
    parameters: 'temperature 1',
    model_info: { 'gptoss.context_length': 131072, 'gptoss.rope.scaling.original_context_length': 4096 },
  }), { configuredContext: undefined, numPredict: undefined, maxContext: 131072 });
});

test('limits: 80 % of the context, answer a tenth (max 12288), rest for the text', () => {
  assert.deepEqual(limitsFromContext(131072, 24576), { numCtx: 104448, maxTokens: 10444, contextChars: 323000 });
  assert.deepEqual(limitsFromContext(20480), { numCtx: 16384, maxTokens: 1638, contextChars: 46000 });
  assert.deepEqual(limitsFromContext(8192, 500), { numCtx: 6144, maxTokens: 400, contextChars: 14000 });
});

test('configured context wins over the model maximum', () => {
  assert.equal(describeSource({ configuredContext: 131072, maxContext: 262144 }).context, 131072);
  assert.equal(describeSource({ maxContext: 262144 }).context, 262144);
  assert.equal(describeSource({}).context, undefined);
});
