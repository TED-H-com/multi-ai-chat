import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

function loadContinuity() {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const context = vm.createContext({ console });
  function load(file: string): Record<string, unknown> {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(file, module);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = vm.runInContext(
      `(function(require, module, exports) {${code}\n})`,
      context,
      { filename: file },
    );
    run((relative: string) => load(path.resolve(path.dirname(file), `${relative}.ts`)), module, module.exports);
    return module.exports;
  }
  return load(path.join(root, 'src/shared/conversationContinuity.ts')) as { buildConversationReplayContext: any };
}

test('buildConversationReplayContext performs within limits', () => {
  const { buildConversationReplayContext } = loadContinuity();

  const messages: any[] = Array.from({ length: 100 }, (_, i) => ({
    id: `msg-${i}`, role: i % 2 === 0 ? 'user' : 'ai', content: 'x'.repeat(1000), timestamp: 1,
  }));

  const start = performance.now();
  for(let i=0; i<100; i++) {
    buildConversationReplayContext(messages);
  }
  const end = performance.now();

  assert.ok((end - start) < 500, `Took too long: ${end - start}ms`);
});
