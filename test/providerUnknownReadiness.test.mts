import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

for (const provider of ['claude', 'gemini']) {
  test(`${provider}: missing composer is unknown, not evidence of logout`, () => {
    let config: any;
    class Composer {
      tagName = 'DIV';
      isContentEditable = true;
      visible = true;
      readOnly = false;
      getAttribute(name: string) { return name === 'contenteditable' ? 'true' : null; }
      closest(selector: string) {
        if (selector.includes('[inert]')) return this.readOnly ? this : null;
        // The current Gemini composer is a Quill editor inside rich-textarea.
        if (provider === 'gemini' && selector.includes('rich-textarea')) return {};
        return null;
      }
      matches() { return true; }
      getClientRects() { return this.visible ? [{}] : []; }
    }
    let composer: Composer | null = null;
    const context = vm.createContext({
      HTMLElement: Composer,
      window: { getComputedStyle: (element: Composer) => ({ display: element.visible ? 'block' : 'none', visibility: 'visible', opacity: '1' }) },
      document: { querySelector: () => composer, querySelectorAll: () => composer ? [composer] : [] },
    });
    function load(file: URL): any {
      const module = { exports: {} };
      const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
      vm.runInContext(`(function(require, module, exports) {${compiled}\n})`, context)(
        (name: string) => name === './base'
          ? { createContentScript: (value: unknown) => { config = value; } }
          : load(new URL(`${name}.ts`, file)), module, module.exports,
      );
      return module.exports;
    }
    load(new URL(`../src/content/${provider}.ts`, import.meta.url));
    assert.equal(config.provider, provider);
    assert.equal(config.loginDetector(), null, 'loading, removed or quota-gated markup must not imply authentication failure');
    composer = new Composer();
    assert.equal(config.loginDetector(), true);
    if (provider === 'gemini') {
      composer.visible = false;
      assert.equal(config.loginDetector(), null, 'hidden markup does not establish readiness');
      composer.visible = true;
      composer.readOnly = true;
      assert.equal(config.loginDetector(), null, 'gated markup does not establish readiness');
    }
    composer = null;
    assert.equal(config.loginDetector(), null, 'losing an existing composer must remain unknown');
  });
}
