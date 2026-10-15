import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { encodeError } from '../src/shared/errors.ts';
import ts from 'typescript';

function classifier(): (reason: string) => string {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const context = vm.createContext({});
  const load = (file: string): Record<string, unknown> => {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(file, module);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = vm.runInContext(`(function(require, module, exports) {${source}\n})`, context, { filename: file });
    run((relative: string) => load(path.resolve(path.dirname(file), `${relative}.ts`)), module, module.exports);
    return module.exports;
  };
  return load(path.join(root, 'src/background/recoveryFailure.ts')).classifyProviderFailure as (reason: string) => string;
}

test('recovery diagnostics classify the provider failure stage without retaining prompt content', () => {
  const classifyProviderFailure = classifier();
  const cases = [
    [encodeError('error.input_injection_failed', { provider: 'Gemini', detail: 'editor replaced' }), 'prompt_insertion'],
    [encodeError('error.send_unconfirmed', { provider: 'Grok' }), 'submission'],
    [encodeError('error.timeout', { provider: 'Claude', seconds: 600 }), 'response_timeout'],
    [encodeError('error.no_response_text', { provider: 'Meta AI' }), 'response_extraction'],
    ['[Error: sign in required]', 'authentication'],
    ['[Error: quota exhausted]', 'quota_or_rate_limit'],
    [encodeError('error.reloaded', { provider: 'ChatGPT' }), 'navigation'],
    ['[Error: provider returned an unclassified transport error]', 'unexpected'],
  ] as const;

  for (const [reason, expected] of cases) assert.equal(classifyProviderFailure(reason), expected);
});
