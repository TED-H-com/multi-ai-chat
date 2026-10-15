import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';

import { connectionForStatusReport } from '../src/background/providerTabOwnership.ts';
import type { AIConnection, AIProvider } from '../src/shared/types.ts';

// Exercise the actual ChatGPT entry point and content engine without reading a
// browser session. Only synthetic account controls and composer nodes are used.
function content(t: TestContext) {
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { callback: () => void; at: number; interval?: number }>();
  function schedule(callback: () => void, delay: number, repeat = false) {
    const id = ++timerId;
    timers.set(id, { callback, at: now + delay, interval: repeat ? delay : undefined });
    return id;
  }
  const clock = {
    setTimeout: (callback: () => void, delay: number) => schedule(callback, delay),
    setInterval: (callback: () => void, delay: number) => schedule(callback, delay, true),
    clearTimeout: (id: number) => { timers.delete(id); },
    clearInterval: (id: number) => { timers.delete(id); },
  };
  function tick(ms: number) {
    const until = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until)
        .sort(([idA, a], [idB, b]) => a.at - b.at || idA - idB)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.interval !== undefined) timer.at += timer.interval;
      else timers.delete(id);
      timer.callback();
    }
    now = until;
  }
  class Control {
    id = '';
    tagName = 'DIV';
    isContentEditable = true;
    disabled = false;
    readOnly = false;
    visible = true;
    opacity = '1';
    proseMirror = false;
    explicitComposer = false;
    currentComposerForm = false;
    gated = false;
    form: Control | null = null;
    children: Control[] = [];
    attributes: Record<string, string> = {};
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    hasAttribute(name: string) { return name in this.attributes; }
    getClientRects() { return this.visible ? [{}] : []; }
    closest(selector: string): unknown {
      if (selector === 'form') return this.form;
      if (selector.includes('[inert]')) return this.gated || this.form?.gated ? this : null;
      if (selector.includes('form[data-chatgpt-composer]') && this.currentComposerForm) return this;
      if (selector.includes('[data-testid*="composer"]')) return this.explicitComposer ? this : null;
      return null;
    }
    querySelector(selector: string) {
      return this.children.find(child => selector.split(', ').some(part => matches(child, part))) ?? null;
    }
  }
  function matches(control: Control, selector: string): boolean {
    if (selector === '#prompt-textarea' || selector === '#composer-submit-button') return control.id === selector.slice(1);
    if (selector === '.ProseMirror[contenteditable="true"]') return control.proseMirror && control.isContentEditable;
    if (selector === 'div[contenteditable="true"][data-placeholder]') return control.isContentEditable && control.hasAttribute('data-placeholder');
    const testId = selector.match(/^(?:button)?\[data-testid="([^"]+)"\]$/)?.[1];
    if (testId) return control.getAttribute('data-testid') === testId;
    const ariaLabel = selector.match(/^button\[aria-label="([^"]+)"\]$/)?.[1];
    if (ariaLabel) return control.tagName === 'BUTTON' && control.getAttribute('aria-label') === ariaLabel;
    return false;
  }
  const nodes: Control[] = [];
  const listeners = new Set<Function>();
  let mutate: Function = () => {};
  let reports = 0;
  let rejectNextReport = false;
  let connection: AIConnection = { provider: 'chatgpt', status: 'checking', tabId: 1 };
  const window = {
    ...clock,
    getComputedStyle: (element: Control) => ({ display: element.visible ? 'block' : 'none', visibility: 'visible', opacity: element.opacity }),
  } as any;
  const context = vm.createContext({
    window, ...clock, Date: class extends Date { static now() { return now; } },
    HTMLElement: Control,
    document: { body: {}, querySelectorAll: (selector: string) => nodes.filter(node => matches(node, selector)) },
    MutationObserver: class {
      constructor(callback: Function) { mutate = callback; }
      observe() {}
      disconnect() {}
    },
    chrome: { runtime: {
      id: 'test',
      sendMessage: async (message: any) => {
        if (message.action !== 'STATUS_REPORT') return;
        reports++;
        if (rejectNextReport) { rejectNextReport = false; throw new Error('worker unavailable'); }
        connection = connectionForStatusReport(connection, message.provider, 1, message.payload.loggedIn);
      },
      onMessage: { addListener: (listener: Function) => listeners.add(listener), removeListener: (listener: Function) => listeners.delete(listener) },
    } },
  });
  const cache = new Map<string, any>();
  function load(file: string): any {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInContext(`(function(require, module, exports) {${code}\n})`, context)(
      (relative: string) => load(path.resolve(path.dirname(file), `${relative}.ts`)), module, module.exports,
    );
    return module.exports;
  }
  function inject() {
    cache.clear();
    load(fileURLToPath(new URL('../src/content/chatgpt.ts', import.meta.url)));
  }
  function control(options: Partial<Control>) { return Object.assign(new Control(), options); }
  t.after(() => window.__multiAiChat_chatgpt?.dispose());
  return {
    control, nodes, tick, inject,
    mutate: () => mutate(),
    account: (visible = true) => nodes.push(control({ tagName: 'BUTTON', visible, attributes: { 'data-testid': 'accounts-profile-button' } })),
    profileMenu: (visible = true) => nodes.push(control({
      tagName: 'BUTTON',
      visible,
      attributes: { 'aria-label': 'Open profile menu', 'aria-haspopup': 'menu' },
    })),
    prompt: (options: Partial<Control> = {}) => {
      const input = control({ id: 'prompt-textarea', ...options });
      nodes.push(input);
      return input;
    },
    markdownComposer: (options: Partial<Control> = {}) => {
      const input = control({
        proseMirror: true,
        currentComposerForm: true,
        attributes: { 'data-composer-markdown': '', role: 'textbox' },
        ...options,
      });
      nodes.push(input);
      return input;
    },
    login: (visible = true) => nodes.push(control({ tagName: 'BUTTON', visible, attributes: { 'data-testid': 'login-button' } })),
    status: () => connection.status,
    reports: () => reports,
    listeners: () => listeners.size,
    rejectReport: () => { rejectNextReport = true; },
    resetWorker: () => { connection = { provider: 'chatgpt', status: 'checking', tabId: 1 }; },
    probe: (provider: AIProvider = 'chatgpt') => {
      let reply: any;
      for (const listener of listeners) listener({ action: 'CHECK_STATUS', provider }, {}, (value: any) => { reply = value; });
      return reply;
    },
  };
}

test('an authenticated ChatGPT account with a usable composer reports Ready', t => {
  const app = content(t);
  app.account();
  app.prompt();
  app.inject();
  assert.equal(app.status(), 'connected');
});

test('the current Open profile menu control with a usable composer reports Ready', t => {
  const app = content(t);
  app.profileMenu();
  app.prompt();
  app.inject();
  assert.equal(app.status(), 'connected');
});

test('the current profile menu and ProseMirror inside the current composer form report Ready', t => {
  const app = content(t);
  app.profileMenu();
  app.markdownComposer();
  app.inject();
  assert.equal(app.status(), 'connected');
});

test('a current profile menu rejects marker-only, unrelated, disabled, read-only or hidden editors', t => {
  const cases: Array<[string, Partial<ReturnType<ReturnType<typeof content>['control']>>]> = [
    ['marker-only editor outside the current composer form', { currentComposerForm: false }],
    ['unrelated ProseMirror editor', { currentComposerForm: false, attributes: { role: 'textbox' } }],
    ['disabled marked editor', { disabled: true }],
    ['read-only marked editor', { readOnly: true }],
    ['hidden marked editor', { visible: false }],
  ];
  for (const [name, options] of cases) {
    const app = content(t);
    app.profileMenu();
    app.markdownComposer(options);
    app.inject();
    app.tick(30000);
    assert.equal(app.status(), 'checking', name);
  }
});

test('the current Open profile menu control without a usable composer remains Checking', t => {
  const app = content(t);
  app.profileMenu();
  app.inject();
  app.tick(30000);
  assert.equal(app.status(), 'checking');
});

test('a guest composer alone is not authentication evidence', t => {
  const app = content(t);
  app.prompt();
  app.inject();
  assert.equal(app.status(), 'checking');
});

test('a signed-out ChatGPT page with a guest composer reports Sign in', t => {
  const app = content(t);
  app.prompt();
  app.login();
  app.inject();
  assert.equal(app.status(), 'login-required');
});

test('an unknown DOM never expires into Sign in without logout evidence', t => {
  const app = content(t);
  app.inject();
  app.tick(30000);
  assert.equal(app.status(), 'checking');
});

test('delayed hydration and SPA composer remount recover without stale Sign in', t => {
  const app = content(t);
  app.inject();
  app.tick(3000);
  assert.equal(app.status(), 'checking');
  app.account();
  const input = app.prompt();
  app.mutate();
  assert.equal(app.status(), 'connected');
  app.nodes.splice(app.nodes.indexOf(input), 1);
  app.mutate();
  app.tick(3000);
  assert.equal(app.status(), 'checking');
  app.prompt();
  app.mutate();
  assert.equal(app.status(), 'connected');
});

test('an authenticated fallback editor in a form with composer-submit-button is recognized', t => {
  const app = content(t);
  app.account();
  app.prompt({ visible: false });
  const form = app.control({ children: [app.control({ id: 'composer-submit-button', tagName: 'BUTTON', disabled: true })] });
  app.nodes.push(app.control({ proseMirror: true, form }));
  app.inject();
  assert.equal(app.status(), 'connected');
});

test('an account control does not make a disabled, read-only, inert, hidden or noneditable composer Ready', t => {
  for (const options of [
    { disabled: true }, { readOnly: true }, { gated: true }, { visible: false }, { opacity: '0' }, { isContentEditable: false },
  ]) {
    const app = content(t);
    app.account();
    app.prompt(options);
    app.inject();
    app.tick(3000);
    assert.equal(app.status(), 'checking');
  }
});

test('hidden login controls do not override an authenticated composer', t => {
  const app = content(t);
  app.account();
  app.prompt();
  app.login(false);
  app.inject();
  assert.equal(app.status(), 'connected');
});

test('an account menu inside a collapsed sidebar still identifies an authenticated composer', t => {
  const app = content(t);
  app.account(false);
  app.prompt();
  app.inject();
  assert.equal(app.status(), 'connected');
});

test('visible login evidence overrides a stale mounted account control', t => {
  const app = content(t);
  app.account();
  app.prompt();
  app.login();
  app.inject();
  assert.equal(app.status(), 'login-required');
});

test('visible login evidence overrides a stale current profile-menu control', t => {
  const app = content(t);
  app.profileMenu();
  app.prompt();
  app.login();
  app.inject();
  assert.equal(app.status(), 'login-required');
});

test('page refresh and script reinjection replace listeners and report Ready again', t => {
  const app = content(t);
  app.account();
  app.prompt();
  app.inject();
  app.resetWorker();
  app.inject();
  assert.equal(app.status(), 'connected');
  assert.equal(app.listeners(), 1);
});

test('an explicit handshake reconnects a restarted worker even when the DOM is unchanged', t => {
  const app = content(t);
  app.account();
  app.prompt();
  app.inject();
  app.resetWorker();
  assert.equal(app.probe().ok, true);
  assert.equal(app.status(), 'connected');
});

test('a failed status report recovers on the existing periodic heartbeat', t => {
  const app = content(t);
  app.account();
  app.prompt();
  app.rejectReport();
  app.inject();
  assert.equal(app.status(), 'checking');
  app.tick(10000);
  assert.equal(app.status(), 'connected');
  assert.equal(app.reports(), 2);
});

test('confirmed login-required recovers when the signed-in page finishes rendering', t => {
  const app = content(t);
  app.login();
  app.inject();
  assert.equal(app.status(), 'login-required');
  app.nodes.length = 0;
  app.account();
  app.prompt();
  app.mutate();
  assert.equal(app.status(), 'connected');
});
