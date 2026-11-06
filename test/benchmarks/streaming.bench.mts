import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

function loadApp() {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const codeStr = readFileSync(path.join(root, 'src/sidepanel/App.tsx'), 'utf8');
  const compiled = ts.transpileModule(codeStr, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;

  const extractContext = vm.createContext({
    console, crypto, setTimeout, clearTimeout, React,
    require: () => ({}),
    module: { exports: {} },
    exports: {}
  });

  const runner = vm.runInContext(
    `(function() { ${compiled}\n return { upsertStreamingMessage, finalizeMessage }; })()`,
    extractContext
  );

  return runner as { upsertStreamingMessage: any, finalizeMessage: any };
}

test('streaming message updates perform within latency limits', () => {
  const { upsertStreamingMessage } = loadApp();

  const messages: any[] = Array.from({ length: 50 }, (_, i) => ({
    id: `req-${i}-streaming`,
    role: 'ai',
    provider: 'chatgpt',
    content: 'A'.repeat(i * 10),
    timestamp: 1000,
    requestId: `req-${i}`
  }));

  const pendingRolesRef = { current: {} };
  let pendingRoles = {};
  const setPendingRoles = (cb: any) => { pendingRoles = typeof cb === 'function' ? cb(pendingRoles) : cb; };

  const start = performance.now();
  for (let i = 0; i < 10000; i++) { // increased iteration count
    upsertStreamingMessage(messages, 'chatgpt', 'req-45', 'New content chunk', pendingRolesRef, setPendingRoles);
  }
  const end = performance.now();

  // Relaxed the bound to 500ms since virtual machine eval adds overhead
  assert.ok((end - start) < 500, `Streaming updates took too long: ${end - start}ms`);
});
