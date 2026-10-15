import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

interface AdapterConfig {
  provider: string;
  inputSelectors: string[];
  sendButtonSelectors: string[];
  responseSelectors: string[];
  loginDetector: () => boolean | null;
  isThinking?: () => boolean;
  inputFilter?: (element: Element) => boolean;
  sendButtonFilter?: (element: Element) => boolean;
  stopButtonSelectors?: string[];
}

function captureAdapter(provider: string): AdapterConfig {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const context = vm.createContext({
    HTMLElement: class {}, HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    window: {}, document: {}, setTimeout, clearTimeout,
  });
  const cache = new Map<string, Record<string, unknown>>();
  let config: AdapterConfig | undefined;
  const load = (file: string): Record<string, unknown> => {
    const cached = cache.get(file);
    if (cached) return cached;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(file, module.exports);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = vm.runInContext(`(function(require, module, exports) {${source}\n})`, context, { filename: file });
    run((relative: string) => relative === './base'
      ? { createContentScript: (value: AdapterConfig) => { config = value; } }
      : load(path.resolve(path.dirname(file), `${relative}.ts`)), module, module.exports);
    return module.exports;
  };
  load(path.join(root, `src/content/${provider}.ts`));
  assert.ok(config, `${provider} must register a content adapter`);
  return config;
}

test('every provider adapter implements the shared send, response, and readiness contract', () => {
  for (const provider of ['chatgpt', 'gemini', 'grok', 'meta', 'claude']) {
    const config = captureAdapter(provider);
    assert.equal(config.provider, provider);
    assert.ok(config.inputSelectors.length > 0, `${provider} input selectors`);
    assert.ok(config.sendButtonSelectors.length > 0, `${provider} send selectors`);
    assert.ok(config.responseSelectors.length > 0, `${provider} response selectors`);
    assert.equal(typeof config.loginDetector, 'function', `${provider} readiness detector`);
    assert.equal(typeof config.isThinking, 'function', `${provider} streaming detector`);
    assert.equal(typeof config.inputFilter, 'function', `${provider} scoped input filter`);
    assert.equal(typeof config.sendButtonFilter, 'function', `${provider} scoped send filter`);
    assert.ok((config.stopButtonSelectors?.length ?? 0) > 0, `${provider} stop selectors`);
  }
});

test('Claude rejects unrelated editors and send buttons outside its composer scope', () => {
  const config = captureAdapter('claude');
  const element = (options: { prose?: boolean; fieldset?: boolean; button?: boolean; label?: string } = {}) => ({
    isContentEditable: true,
    disabled: false,
    getAttribute: (name: string) => name === 'contenteditable' ? 'true'
      : name === 'aria-label' ? options.label ?? null : null,
    matches: (selector: string) => options.button ? selector === 'button'
      : Boolean(options.prose && selector.includes('ProseMirror')),
    closest: (selector: string) => selector === 'fieldset' && options.fieldset ? {} : null,
  }) as unknown as Element;
  assert.equal(config.inputFilter?.(element({ prose: true })), true);
  assert.equal(config.inputFilter?.(element({ fieldset: true })), true);
  assert.equal(config.inputFilter?.(element()), false);
  assert.equal(config.sendButtonFilter?.(element({ button: true, fieldset: true })), true);
  assert.equal(config.sendButtonFilter?.(element({ button: true, label: 'Send message' })), true);
  assert.equal(config.sendButtonFilter?.(element({ button: true })), false);
});

test('Gemini sends its verified first click without a background-tab timer, while ChatGPT tracks remounted responses semantically', () => {
  const gemini = captureAdapter('gemini');
  const chatgpt = captureAdapter('chatgpt');
  assert.equal(gemini.sendConfirmation, 'single-activation');
  assert.equal(gemini.immediateSendAfterInsertion, true);
  assert.equal(chatgpt.responseTracking, 'semantic-latest');
});
