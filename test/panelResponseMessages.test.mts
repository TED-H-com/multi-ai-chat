import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

import type { ChatMessage } from '../src/shared/types.ts';

// Test the actual panel finalization functions, including role handling. Do not
// render or read a user's stored conversations.
function panelMessages() {
  const nativeRequire = createRequire(import.meta.url);
  const context = vm.createContext({
    navigator: { language: 'en' }, crypto: { randomUUID }, Date,
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
  });
  const cache = new Map<string, any>();
  function load(file: string): any {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    let code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText;
    if (file.endsWith('App.tsx')) code += '\nmodule.exports.testMessages = { upsertStreamingMessage, finalizeMessage };';
    vm.runInContext(`(function(require, module, exports) {${code}\n})`, context)(
      (relative: string) => {
        if (!relative.startsWith('.')) return nativeRequire(relative);
        const target = path.resolve(path.dirname(file), relative);
        return load(existsSync(`${target}.ts`) ? `${target}.ts` : `${target}.tsx`);
      }, module, module.exports,
    );
    return module.exports;
  }
  const helpers = load(fileURLToPath(new URL('../src/sidepanel/App.tsx', import.meta.url))).testMessages;
  const roleRef = { current: { request: 'role.judge' } as Record<string, string> };
  const setRoles = (update: (previous: Record<string, string>) => Record<string, string>) => { roleRef.current = update(roleRef.current); };
  return {
    chunk: (messages: ChatMessage[], requestId = 'request', provider = 'grok', text = 'partial') => helpers.upsertStreamingMessage(messages, provider, requestId, text, roleRef, setRoles),
    done: (messages: ChatMessage[], requestId = 'request', provider = 'grok', text = 'complete') => helpers.finalizeMessage(messages, provider, requestId, text, roleRef, setRoles),
  };
}

test('duplicate final responses are idempotent and retain their original attribution', () => {
  const panel = panelMessages();
  const first = panel.done([]);
  const duplicate = panel.done(first, 'request', 'grok', 'duplicate');
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].content, 'complete');
  assert.equal(duplicate[0].provider, 'grok');
  assert.equal(duplicate[0].modeRole, 'role.judge');
});

test('late chunks cannot resurrect a completed response as streaming', () => {
  const panel = panelMessages();
  const done = panel.done(panel.chunk([]));
  const late = panel.chunk(done, 'request', 'grok', 'late partial');
  assert.equal(late.length, 1);
  assert.equal(late[0].content, 'complete');
  assert.equal(late[0].id.endsWith('-streaming'), false);
});

test('one provider may complete several distinct requests without merging contributions', () => {
  const panel = panelMessages();
  const first = panel.done([]);
  const second = panel.done(panel.chunk(first, 'request-2'), 'request-2', 'grok', 'second answer');
  assert.equal(second.length, 2);
  assert.equal(second[0].content, 'complete');
  assert.equal(second[1].content, 'second answer');
});
