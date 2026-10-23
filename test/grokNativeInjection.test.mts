import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real Grok adapter's contenteditable injection, rather than
// merely checking source text or stubbing away the native insertion path.
function grokNativeHarness(nativeText: string, reconcileAfterMs: number | null) {
  const editor = {
    tagName: 'DIV', innerText: '', textContent: '', isConnected: true,
    focus() {},
  };
  let calls = 0;
  let config: any;
  const selection = { removeAllRanges() {}, addRange() {} };
  const doc = {
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: () => {
      calls += 1;
      editor.innerText = nativeText;
      editor.textContent = nativeText;
      if (reconcileAfterMs !== null) {
        setTimeout(() => {
          editor.innerText = 'complete prompt';
          editor.textContent = 'complete prompt';
        }, reconcileAfterMs);
      }
      return true;
    },
  };
  const fakeDom = {
    grokComposerMatches: (input: typeof editor, expected: string) => input.innerText === expected,
    readGrokComposerText: (input: typeof editor) => input.innerText,
  };
  const file = fileURLToPath(new URL('../src/content/grok.ts', import.meta.url));
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  const context = vm.createContext({
    window: { getSelection: () => selection },
    document: doc,
    HTMLElement: class {}, HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    Date, setTimeout,
  });
  const base = { createContentScript: (adapter: any) => { config = adapter; } };
  const required: Record<string, unknown> = {
    './base': base,
    './focusWithoutScroll': { focusWithoutScroll: (element: typeof editor) => element.focus() },
    './grokDom': fakeDom,
  };
  vm.runInContext(`(function(require, module, exports) { ${code}\n})`, context)(
    (key: string) => required[key] ?? {}, mod, mod.exports,
  );
  return { editor, calls: () => calls, inject: (expected: string, isActive?: () => boolean) => config.injectInput(editor, expected, isActive) as Promise<void> };
}

test('Grok waits for a delayed ProseMirror reconciliation and edits only once', async () => {
  const native = grokNativeHarness('complete', 50);
  await native.inject('complete prompt');
  assert.equal(native.editor.innerText, 'complete prompt');
  assert.equal(native.calls(), 1);
});

test('Grok native input reconciliation honors a cancelled request without a second edit', async () => {
  const native = grokNativeHarness('partial prompt', null);
  let active = true;
  const promise = native.inject('complete prompt', () => active);
  setTimeout(() => { active = false; }, 30);
  await assert.rejects(promise, /request cancelled during native editor reconciliation/);
  assert.equal(native.calls(), 1);
});
