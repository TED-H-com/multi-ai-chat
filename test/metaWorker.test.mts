import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { ALL_PROVIDERS, activeProviders, readyActiveTargets } from '../src/shared/providerSelection.ts';
import { AI_PROVIDERS } from '../src/shared/constants.ts';
import type { AIProvider, ConsultRoles, DebateRoles, RoundtableRoles } from '../src/shared/types.ts';
import { decodeError } from '../src/shared/errors.ts';
import { openUnreadyProviders } from '../src/sidepanel/openUnreadyProviders.ts';
import { META_ORIGINS } from '../src/shared/metaOrigins.ts';

const META_CONTENT_SCRIPT_ID = 'meta-ai';

const META_DEBATE: DebateRoles = { pro: 'meta', con: 'chatgpt', judge: 'claude', summary: 'gemini' };
const META_CONSULT: ConsultRoles = { first: 'meta', second: 'chatgpt', reviewer: 'claude', summary: 'gemini' };
const META_ROUNDTABLE: RoundtableRoles = { first: 'meta', second: 'chatgpt', third: 'claude', fourth: 'gemini' };

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function completeRemaining(app: ReturnType<typeof worker>, running: Promise<unknown>): Promise<unknown> {
  const completed = new Set<string>();
  const start = Date.now();
  let settled = false;
  const finished = Promise.resolve(running).then((value) => {
    settled = true;
    return value;
  });
  while (!settled) {
    if (Date.now() - start > 5000) {
      throw new Error(`did not finish workflow: sent=${app.sent.length} completed=${completed.size}`);
    }
    for (const message of app.sent) {
      if (!message.requestId || completed.has(message.requestId)) continue;
      completed.add(message.requestId);
      app.complete(message);
    }
    await Promise.race([finished, new Promise((resolve) => setImmediate(resolve))]);
  }
  return finished;
}

// Run the actual service worker against a Chrome transport double. Transpile its
// extensionless browser imports without changing production module resolution.
function worker(
  stored: Record<string, unknown> = {},
  autoRespond = true,
  readiness: Partial<Record<AIProvider, boolean | null>> = {},
  missingTabs: AIProvider[] = [],
  extras: {
    session?: Record<string, unknown>;
    rejectSend?: AIProvider[];
    metaHostPermitted?: boolean;
    resumeSnapshot?: { state: string; submission: 'not_submitted' | 'uncertain' | 'submitted'; response?: string };
  } = {},
) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const sent: any[] = [];
  const stops: any[] = [];
  const broadcasts: any[] = [];
  const navigated: number[] = [];
  const navigations: { tabId: number; url?: string }[] = [];
  const created: { url: string }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const local = { ...stored };
  const session: Record<string, unknown> = { ...extras.session };
  const rejectSend = extras.rejectSend ?? [];
  const broadcastHold: { current?: (message: any) => Promise<void> | void } = {};
  const sessionGetHold: { current?: () => Promise<void> } = {};
  const navigationHold: { current?: (tabId: number, options?: { url?: string }) => Promise<void> } = {};
  const sendAcknowledgement: { current?: (message: any) => Promise<unknown> | unknown } = {};
  const documentProbeHold: { current?: (tabId: number) => Promise<void> } = {};
  const scriptExecutions: any[] = [];
  const tabs: Array<{ id: number; url: string; status?: string }> = ALL_PROVIDERS.flatMap((provider, index) => (
    missingTabs.includes(provider) ? [] : [{ id: index + 1, url: AI_PROVIDERS[provider].url }]
  ));
  const documentIds = new Map(tabs.map((tab) => [tab.id, `document-${tab.id}-initial`]));
  interface DynamicScript {
    id: string;
    matches?: readonly string[];
    js?: readonly string[];
    runAt?: string;
    persistAcrossSessions?: boolean;
  }
  const dynamicScripts: DynamicScript[] = [];
  const contentScriptErrors: string[] = [];
  // A stored non-meta standby is only legal while meta.ai access is granted.
  // Tests of the stuck state pass metaHostPermitted: false.
  let metaHostPermitted = extras.metaHostPermitted ?? (
    typeof stored.standbyProvider === 'string' && stored.standbyProvider !== 'meta'
  );
  function event() {
    return { listeners: [] as Function[], addListener(listener: Function) { this.listeners.push(listener); } };
  }
  function storage(values: Record<string, unknown>, beforeGet?: { current?: () => Promise<void> }) {
    return {
      get: async (keys: string | string[]) => {
        const snapshot = Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]));
        if (beforeGet?.current) await beforeGet.current();
        return snapshot;
      },
      set: async (updates: Record<string, unknown>) => { Object.assign(values, updates); },
      remove: async (key: string) => { delete values[key]; },
      setAccessLevel: async () => {},
    };
  }
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: { local: storage(local), session: storage(session, sessionGetHold) },
    runtime: {
      onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event(),
      sendMessage: async (message: any) => {
        if (broadcastHold.current) await broadcastHold.current(message);
        broadcasts.push(message);
      },
    },
    tabs: {
      onUpdated: event(), onRemoved: event(), onReplaced: event(),
      query: async () => tabs,
      get: async (id: number) => tabs.find((tab) => tab.id === id),
      create: async (options: { url: string }) => { created.push(options); },
      update: async (id: number, options?: { url?: string }) => {
        navigated.push(id);
        navigations.push({ tabId: id, url: options?.url });
        if (navigationHold.current) await navigationHold.current(id, options);
        return tabs.find((tab) => tab.id === id);
      },
      sendMessage: async (id: number, message: any, options?: { documentId?: string }) => {
        if (options?.documentId && options.documentId !== documentIds.get(id)) {
          throw new Error('No matching document for this message');
        }
        if (message.action === 'CHECK_STATUS') {
          const provider = message.provider as AIProvider;
          receive({ action: 'STATUS_REPORT', provider, payload: { loggedIn: provider in readiness ? readiness[provider] : true } }, { tab: tabs.find((tab) => tab.id === id) });
        }
        if (message.action === 'SEND_MESSAGE') {
          sent.push({ ...message, tabId: id, documentId: options?.documentId });
          if (rejectSend.includes(message.provider)) return { ok: false, error: 'already responding' };
          if (autoRespond) complete(sent.at(-1));
          if (sendAcknowledgement.current) return await sendAcknowledgement.current(sent.at(-1));
        }
        if (message.action === 'QUERY_PROVIDER_REQUEST_STATE') return extras.resumeSnapshot ?? { state: 'idle', submission: 'not_submitted' };
        if (message.action === 'STOP_GENERATION') stops.push({ ...message, tabId: id });
        return { ok: true };
      },
    },
    windows: { update: async () => {} },
    permissions: {
      contains: async () => metaHostPermitted,
      onAdded: event(),
      onRemoved: event(),
    },
    scripting: {
      executeScript: async (injection: any) => {
        scriptExecutions.push(injection);
        const tabId = injection.target?.tabId as number | undefined;
        if (!tabId) return [];
        if (injection.target?.documentIds?.some((documentId: string) => documentId !== documentIds.get(tabId))) {
          throw new Error('No matching document for this injection');
        }
        if (!injection.func) return [];
        if (documentProbeHold.current) await documentProbeHold.current(tabId);
        const documentId = documentIds.get(tabId);
        return documentId ? [{ frameId: 0, documentId }] : [];
      },
      getRegisteredContentScripts: async () => dynamicScripts.map((script) => ({ ...script })),
      registerContentScripts: async (scripts: DynamicScript[]) => {
        for (const script of scripts) {
          if (dynamicScripts.some((existing) => existing.id === script.id)) {
            const error = new Error(`Duplicate script ID '${script.id}'`);
            contentScriptErrors.push(error.message);
            throw error;
          }
          dynamicScripts.push({
            ...script,
            matches: script.matches ? [...script.matches] : undefined,
            js: script.js ? [...script.js] : undefined,
          });
        }
      },
      unregisterContentScripts: async (filter?: { ids?: readonly string[] }) => {
        const ids = filter?.ids;
        if (!ids || ids.length === 0) {
          const error = new Error('refusing to unregister every dynamic content script');
          contentScriptErrors.push(error.message);
          throw error;
        }
        for (const id of ids) {
          const index = dynamicScripts.findIndex((script) => script.id === id);
          if (index >= 0) dynamicScripts.splice(index, 1);
        }
      },
    },
  };
  function senderForTab(tabId: number, documentId = documentIds.get(tabId)) {
    return { tab: tabs.find((tab) => tab.id === tabId), documentId, frameId: 0 };
  }
  function receive(message: any, sender: any = {}, reply: Function = () => {}) {
    const normalizedSender = sender.tab?.id !== undefined && sender.documentId === undefined
      ? { ...sender, documentId: documentIds.get(sender.tab.id), frameId: sender.frameId ?? 0 }
      : sender;
    return chrome.runtime.onMessage.listeners[0](message, normalizedSender, reply);
  }
  function command(message: any, sender: any = {}): Promise<any> {
    return new Promise((resolve) => receive(message, sender, resolve));
  }
  function complete(message: any, payload = 'answer', documentId = documentIds.get(message.tabId)) {
    receive({ ...message, action: 'RESPONSE_DONE', payload }, senderForTab(message.tabId, documentId));
  }
  function fail(message: any, payload = '[Error: quota]') {
    complete(message, payload);
  }
  function removeTab(tabId: number) {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index >= 0) tabs.splice(index, 1);
    documentIds.delete(tabId);
    for (const listener of chrome.tabs.onRemoved.listeners) listener(tabId);
  }
  function updateTab(tabId: number, changeInfo: Record<string, unknown>) {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`missing tab ${tabId}`);
    if (typeof changeInfo.url === 'string') tab.url = changeInfo.url;
    if (typeof changeInfo.status === 'string') tab.status = changeInfo.status;
    for (const listener of chrome.tabs.onUpdated.listeners) listener(tabId, changeInfo, { ...tab });
  }
  function replaceTab(removedTabId: number, addedTabId: number) {
    const index = tabs.findIndex((tab) => tab.id === removedTabId);
    if (index < 0) throw new Error(`missing tab ${removedTabId}`);
    const previous = tabs[index];
    tabs[index] = { ...previous, id: addedTabId };
    documentIds.delete(removedTabId);
    documentIds.set(addedTabId, `document-${addedTabId}-replacement`);
    for (const listener of chrome.tabs.onReplaced.listeners) listener(addedTabId, removedTabId);
  }
  const context = vm.createContext({
    chrome, console, URL, DOMException, crypto, TextEncoder,
    setTimeout: (...args: Parameters<typeof setTimeout>) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        args[0](...args.slice(2));
      }, args[1]);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
  });
  const cache = new Map<string, { exports: unknown }>();
  function load(file: string): unknown {
    if (cache.has(file)) return cache.get(file)!.exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const inspectWaiters = file === path.join(root, 'src/background/service-worker.ts')
      ? '\nmodule.exports.pendingResponseCount = () => responseWaiters.size;'
      : '';
    const run = vm.runInContext(`(function(require, module, exports) {${code}${inspectWaiters}\n})`, context, { filename: file });
    run((relative: string) => load(path.resolve(path.dirname(file), `${relative}.ts`)), module, module.exports);
    return module.exports;
  }
  const workerState = load(path.join(root, 'src/background/service-worker.ts')) as { pendingResponseCount: () => number };
  const ready = new Promise<void>((resolve) => setImmediate(resolve));
  return {
    command, receive, sent, stops, broadcasts, local, session, navigated, navigations, created, ready, complete, fail, removeTab,
    updateTab, replaceTab, scriptExecutions,
    dynamicScripts, contentScriptErrors, permissions: chrome.permissions, runtime: chrome.runtime,
    holdBroadcasts(handler?: (message: any) => Promise<void> | void) { broadcastHold.current = handler; },
    holdSessionGets(handler?: () => Promise<void>) { sessionGetHold.current = handler; },
    holdNavigations(handler?: (tabId: number, options?: { url?: string }) => Promise<void>) { navigationHold.current = handler; },
    holdDocumentProbes(handler?: (tabId: number) => Promise<void>) { documentProbeHold.current = handler; },
    holdSendAcknowledgements(handler?: (message: any) => Promise<unknown> | unknown) { sendAcknowledgement.current = handler; },
    documentId(tabId: number) { return documentIds.get(tabId); },
    setDocumentId(tabId: number, documentId?: string) {
      if (documentId) documentIds.set(tabId, documentId);
      else documentIds.delete(tabId);
    },
    pendingResponseCount: workerState.pendingResponseCount,
    pendingTimerCount: () => timers.size,
    grantMetaHostAccess: (granted: boolean) => { metaHostPermitted = granted; },
    close: () => { for (const timer of timers) clearTimeout(timer); },
    send: (mode = 'free', targets?: string[], options: {
      roles?: DebateRoles | ConsultRoles | RoundtableRoles;
      sessionId?: string;
      clientId?: string;
      workflowId?: string;
      text?: string;
      recovery?: { enabled: boolean; policy: 'safe' | 'strict' | 'best-effort' };
    } = {}) => {
      const payload = {
        workflowId: options.workflowId ?? crypto.randomUUID(),
        sessionId: options.sessionId ?? 'session',
        clientId: options.clientId ?? 'client',
        text: options.text ?? 'Hello',
        mode,
        targets,
        recovery: options.recovery,
        roles: options.roles,
      };
      return command({ action: 'SEND_MESSAGE', payload }).then((result) => ({ ...result, ...payload }));
    },
  };
}

test('worker default fanout excludes Meta even with all five tabs connected', async (t) => {
  const app = worker();
  t.after(app.close);
  await app.ready;
  assert.equal((await app.send('free', ALL_PROVIDERS)).ok, true);
  assert.deepEqual(app.sent.map((message) => message.provider), activeProviders('meta'));
  assert.equal((await app.command({ action: 'OPEN_LOGIN', provider: 'meta' })).ok, false);
});

test('worker swaps Meta into fanout and leaves standby tabs untouched during session restore/reset', async (t) => {
  const app = worker({ freeTargets: activeProviders('meta') });
  t.after(app.close);
  await app.ready;
  const result = await app.command({ action: 'SET_STANDBY_PROVIDER', payload: { standbyProvider: 'grok' } });
  assert.equal(result.ok, true);
  assert.equal(app.local.standbyProvider, 'grok');
  assert.deepEqual(Array.from(result.freeTargets), ['chatgpt', 'claude', 'gemini', 'meta']);
  await app.send('free', ALL_PROVIDERS);
  assert.deepEqual(app.sent.map((message) => message.provider), activeProviders('grok'));
  await app.command({ action: 'RESET_PROVIDER_SESSIONS' });
  assert.deepEqual(app.navigated, [1, 2, 3, 5]);
  await app.command({ action: 'RESTORE_PROVIDER_SESSIONS', payload: {
    urls: { grok: 'https://grok.com/chat/old', meta: 'https://www.meta.ai/prompt/current' },
  } });
  assert.deepEqual(app.navigated, [1, 2, 3, 5, 1, 2, 3, 5]);
  assert.deepEqual(app.navigations.slice(4), [
    { tabId: 1, url: AI_PROVIDERS.chatgpt.url },
    { tabId: 2, url: AI_PROVIDERS.claude.url },
    { tabId: 3, url: AI_PROVIDERS.gemini.url },
    { tabId: 5, url: 'https://www.meta.ai/prompt/current' },
  ]);
  assert.equal((await app.command({ action: 'OPEN_LOGIN', provider: 'grok' })).ok, false);
});

test('session restore resets missing or foreign active provider URLs and leaves standby untouched', async (t) => {
  const app = worker();
  t.after(app.close);
  await app.ready;
  await app.command({ action: 'RESTORE_PROVIDER_SESSIONS', payload: {
    urls: {
      chatgpt: 'https://chatgpt.com.evil.example/chat/old',
      claude: 'https://chatgpt.com/chat/other-provider',
      gemini: 'https://gemini.google.com/app/saved',
      meta: 'https://www.meta.ai/prompt/standby',
    },
  } });
  assert.deepEqual(app.navigations, [
    { tabId: 1, url: AI_PROVIDERS.chatgpt.url },
    { tabId: 2, url: AI_PROVIDERS.claude.url },
    { tabId: 3, url: 'https://gemini.google.com/app/saved' },
    { tabId: 4, url: AI_PROVIDERS.grok.url },
  ]);
  assert.equal(app.navigated.includes(5), false);
});

for (const action of ['RESET_PROVIDER_SESSIONS', 'RESTORE_PROVIDER_SESSIONS'] as const) {
  test(`${action} cannot be requested by a content-script tab`, async (t) => {
    const app = worker();
    t.after(app.close);
    await app.ready;
    assert.equal((await app.command({ action }, { tab: { id: 1, url: AI_PROVIDERS.chatgpt.url } })).ok, false);
    assert.equal(app.navigated.length, 0);
  });

  test(`${action} completes before a new workflow can reuse a previous-page readiness report`, async (t) => {
    const app = worker({}, false);
    let release: (() => void) | undefined;
    t.after(() => { release?.(); app.close(); });
    await app.ready;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    let held = 0;
    app.holdNavigations(async (_tabId, options) => {
      if (!options?.url) return;
      held += 1;
      await pause;
    });
    const navigation = app.command({ action });
    await waitUntil(() => held > 0, 'session navigation held');
    app.receive({ action: 'STATUS_REPORT', provider: 'grok', payload: { loggedIn: true } }, {
      tab: { id: 4, url: AI_PROVIDERS.grok.url },
    });
    const running = app.send('free', ['grok'], { sessionId: 'new-session' });
    await flushWorkerTurns();
    assert.equal(app.sent.length, 0);
    release?.();
    app.holdNavigations();
    await navigation;
    app.receive({ action: 'STATUS_REPORT', provider: 'grok', payload: { loggedIn: true } }, {
      tab: { id: 4, url: AI_PROVIDERS.grok.url },
    });
    await waitUntil(() => app.sent.length === 1, 'new-session request after navigation');
    app.complete(app.sent[0]);
    await running;
  });
}

test('a failed session reset cannot reuse prior context and must finish pending navigation before retry', async (t) => {
  const app = worker({}, false);
  let release: (() => void) | undefined;
  t.after(() => { release?.(); app.close(); });
  await app.ready;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  let held = 0;
  app.holdNavigations(async (tabId, options) => {
    if (!options?.url) return;
    if (tabId === 1) throw new Error('session navigation failed');
    held += 1;
    await pause;
  });
  const navigation = app.command({ action: 'RESET_PROVIDER_SESSIONS' });
  await waitUntil(() => held === 3, 'other navigations remain pending');
  const running = app.send('free', ['grok'], { sessionId: 'new-session' });
  await flushWorkerTurns();
  assert.equal(app.broadcasts.some((message) => message.payload?.key === 'workflow.starting'), false);
  release?.();
  app.holdNavigations();
  assert.equal((await navigation).ok, false);
  app.receive({ action: 'STATUS_REPORT', provider: 'grok', payload: { loggedIn: true } }, {
    tab: { id: 4, url: AI_PROVIDERS.grok.url },
  });
  await running;
  assert.equal(app.sent.length, 0);
  assert.ok(app.broadcasts.some((message) => message.provider === 'system' && /session navigation failed/.test(message.payload)));
  assert.equal((await app.command({ action: 'RESET_PROVIDER_SESSIONS' })).ok, true);
  app.receive({ action: 'STATUS_REPORT', provider: 'grok', payload: { loggedIn: true } }, {
    tab: { id: 4, url: AI_PROVIDERS.grok.url },
  });
  const retried = app.send('free', ['grok'], { sessionId: 'new-session' });
  await waitUntil(() => app.sent.length === 1, 'send after successful reset retry');
  app.complete(app.sent[0]);
  await retried;
});

test('Stop followed immediately by New Chat reset does not deadlock workflow starts', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const first = app.send('debate');
  await waitUntil(() => app.sent.length === 1, 'old Debate request');
  const cancelled = app.command({ action: 'CANCEL_WORKFLOW', payload: {
    workflowId: app.sent[0].workflowId, sessionId: 'session', clientId: 'client',
  } });
  const reset = app.command({ action: 'RESET_PROVIDER_SESSIONS' });
  assert.equal((await cancelled).ok, true);
  assert.equal((await reset).ok, true);
  await first;
  app.receive({ action: 'STATUS_REPORT', provider: 'grok', payload: { loggedIn: true } }, {
    tab: { id: 4, url: AI_PROVIDERS.grok.url },
  });
  const next = app.send('free', ['grok'], { sessionId: 'new-session' });
  await waitUntil(() => app.sent.length === 2, 'new chat after Stop and reset');
  app.complete(app.sent[1]);
  await next;
  assert.equal(app.pendingResponseCount(), 0);
});

test('a completion before a rejected send acknowledgement cannot become a Debate argument', async (t) => {
  const app = worker({}, false);
  let release: (() => void) | undefined;
  t.after(() => { release?.(); app.close(); });
  await app.ready;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  app.holdSendAcknowledgements(async (message) => {
    app.complete(message, 'normal response before rejected acknowledgement');
    await pause;
    return { ok: false, error: 'content rejected request' };
  });
  const running = app.send('debate');
  await waitUntil(() => app.sent.length === 1, 'request with pending acknowledgement');
  await flushWorkerTurns();
  assert.equal(app.broadcasts.some((message) => message.action === 'RESPONSE_DONE'), false);
  release?.();
  app.holdSendAcknowledgements();
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'rejected acknowledgement recovery');
  assert.equal(app.sent.length, 1);
  assert.equal(app.broadcasts.some((message) => message.payload === 'normal response before rejected acknowledgement'), false);
  const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.match(recovery.reason, /content rejected request/);
  await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'skip' } });
  await completeRemaining(app, running);
  assert.doesNotMatch(app.sent[1].payload.text, /normal response before rejected acknowledgement/);
});

test('a content failure already reported by RESPONSE_DONE keeps provider-scoped recovery instead of a system error', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  app.holdSendAcknowledgements((message) => {
    app.complete(message, '[Error: i18n:{"key":"error.input_injection_failed","params":{"provider":"chatgpt"}}]');
    return { ok: false, error: 'editor text did not match the requested prompt', failureAlreadyReported: true };
  });
  const running = app.send('debate');
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'reported content failure recovery');
  const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal(recovery.provider, 'chatgpt');
  assert.equal(decodeError(recovery.reason)?.key, 'error.input_injection_failed');
  assert.equal(app.broadcasts.some((message) => message.provider === 'system' && /editor text did not match/.test(String(message.payload))), false);
  await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'cancel' } });
  await running;
});

for (const acknowledgement of [undefined, {}, { ok: 'yes' }]) {
  test(`an unconfirmed send acknowledgement ${JSON.stringify(acknowledgement)} cannot relay a successful answer`, async (t) => {
    const app = worker({}, false);
    t.after(app.close);
    await app.ready;
    app.holdSendAcknowledgements((message) => {
      app.complete(message, 'unconfirmed answer');
      return acknowledgement;
    });
    await app.send('free', ['grok']);
    assert.equal(app.broadcasts.some((message) => message.payload === 'unconfirmed answer'), false);
    assert.equal(decodeError(app.broadcasts.find((message) => message.provider === 'system')?.payload)?.key, 'error.send_unconfirmed');
    assert.equal(app.pendingResponseCount(), 0);
  });
}

test('an ambiguous send transport error does not automatically reinject and replay the provider prompt', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  app.holdSendAcknowledgements(() => {
    throw new Error('The message port closed before a response was received.');
  });
  const running = app.send('debate');
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'ambiguous delivery recovery');
  assert.equal(app.sent.length, 1);
  const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  app.holdSendAcknowledgements();
  await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'cancel' } });
  await running;
});

test('a definitely absent content receiver can be injected and sent the same request once', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  let attempt = 0;
  app.holdSendAcknowledgements((message) => {
    attempt += 1;
    if (attempt === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
    app.complete(message, 'confirmed receiver answer');
    return { ok: true };
  });
  await app.send('free', ['grok']);
  assert.equal(app.sent.length, 2);
  assert.equal(app.sent[0].requestId, app.sent[1].requestId);
  assert.equal(app.broadcasts.filter((message) => message.payload === 'confirmed receiver answer').length, 1);
  assert.equal(app.pendingResponseCount(), 0);
  assert.equal(app.pendingTimerCount(), 0);
});

test('an ambiguous repaired send reports uncertain delivery without replaying again', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  let attempt = 0;
  app.holdSendAcknowledgements(() => {
    attempt += 1;
    throw new Error(attempt === 1
      ? 'Could not establish connection. Receiving end does not exist.'
      : 'The message port closed before a response was received.');
  });
  const running = app.send('debate');
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'repaired send uncertainty');
  assert.equal(app.sent.length, 2);
  const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal(decodeError(recovery.reason)?.key, 'error.send_unconfirmed');
  app.holdSendAcknowledgements();
  await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'cancel' } });
  await running;
  assert.equal(app.sent.length, 2);
});

test('cancellation during absent-receiver repair prevents a delayed repeat send', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  app.holdSendAcknowledgements(() => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  });
  const running = app.send('debate');
  await waitUntil(() => app.sent.length === 1, 'first missing-receiver attempt');
  await app.command({ action: 'CANCEL_WORKFLOW', payload: {
    workflowId: app.sent[0].workflowId, sessionId: 'session', clientId: 'client',
  } });
  await running;
  assert.equal(app.sent.length, 1);
  assert.equal(app.pendingResponseCount(), 0);
  assert.equal(app.pendingTimerCount(), 0);
});

test('a provider request fails closed when Chrome cannot identify its document', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  // Gemini is the third default provider tab in this deterministic harness.
  // An empty executeScript result models a browser that cannot prove which
  // document would receive the prompt.
  app.setDocumentId(3);
  await app.send('free', ['gemini']);
  assert.equal(app.sent.length, 0);
  assert.equal(app.pendingResponseCount(), 0);
  assert.equal(app.broadcasts.some((message) => (
    decodeError(String(message.payload))?.key === 'error.send_unconfirmed'
  )), true);
});

test('a bound provider request ignores a stale document response from the same tab', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('free', ['gemini']);
  await waitUntil(() => app.sent.length === 1, 'bound Gemini request');
  const first = app.sent[0];
  const documentId = app.documentId(first.tabId);
  assert.equal(first.documentId, documentId);
  app.receive({ ...first, action: 'RESPONSE_DONE', payload: 'stale document answer' }, {
    tab: { id: first.tabId, url: AI_PROVIDERS.gemini.url }, documentId: 'document-stale', frameId: 0,
  });
  await flushWorkerTurns();
  assert.equal(app.broadcasts.some((message) => message.payload === 'stale document answer'), false);
  assert.equal(app.pendingResponseCount(), 1);
  app.complete(first, 'bound document answer', documentId);
  await running;
  assert.equal(app.broadcasts.some((message) => message.payload === 'bound document answer'), true);
});

test('a bound Gemini request survives same-document loading and completion', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('free', ['gemini']);
  await waitUntil(() => app.sent.length === 1, 'bound Gemini request');
  const first = app.sent[0];
  const documentId = app.documentId(first.tabId);
  assert.equal(first.documentId, documentId);
  const conversationUrl = 'https://gemini.google.com/app/live-conversation';
  app.updateTab(first.tabId, { status: 'loading', url: conversationUrl });
  app.updateTab(first.tabId, { status: 'complete' });
  await flushWorkerTurns();
  assert.equal(app.pendingResponseCount(), 1);
  app.complete(first, 'same document answer', documentId);
  await running;
  assert.equal(app.broadcasts.some((message) => message.payload === 'same document answer'), true);
  assert.equal(app.broadcasts.some((message) => decodeError(String(message.payload))?.key === 'error.reloaded'), false);
});

test('a bound Gemini request rejects a changed document and never accepts its response', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('free', ['gemini']);
  await waitUntil(() => app.sent.length === 1, 'bound Gemini request');
  const first = app.sent[0];
  assert.equal(typeof first.documentId, 'string');
  const conversationUrl = 'https://gemini.google.com/app/new-document';
  app.setDocumentId(first.tabId, 'document-gemini-replacement');
  app.updateTab(first.tabId, { status: 'loading', url: conversationUrl });
  app.updateTab(first.tabId, { status: 'complete' });
  await waitUntil(() => app.broadcasts.some((message) => decodeError(String(message.payload))?.key === 'error.reloaded'), 'document-change failure');
  app.complete(first, 'replacement document answer', 'document-gemini-replacement');
  await flushWorkerTurns();
  assert.equal(app.broadcasts.some((message) => message.payload === 'replacement document answer'), false);
  await running;
  assert.equal(app.pendingResponseCount(), 0);
});

test('a stale document probe cannot reject a request that already completed', async (t) => {
  const app = worker({}, false);
  let release: (() => void) | undefined;
  t.after(() => { release?.(); app.close(); });
  await app.ready;
  const running = app.send('free', ['gemini']);
  await waitUntil(() => app.sent.length === 1, 'bound Gemini request');
  const first = app.sent[0];
  const documentId = app.documentId(first.tabId);
  assert.equal(first.documentId, documentId);
  const probesBefore = app.scriptExecutions.filter((injection) => Boolean(injection.func)).length;
  const held = new Promise<void>((resolve) => { release = resolve; });
  app.holdDocumentProbes(async () => held);
  app.updateTab(first.tabId, { status: 'loading', url: 'https://gemini.google.com/app/pending-probe' });
  await waitUntil(() => app.scriptExecutions.filter((injection) => Boolean(injection.func)).length > probesBefore, 'held document probe');
  app.complete(first, 'answer before probe returns', documentId);
  await running;
  app.setDocumentId(first.tabId, 'document-gemini-after-completion');
  release?.();
  app.holdDocumentProbes();
  await flushWorkerTurns();
  assert.equal(app.broadcasts.some((message) => decodeError(String(message.payload))?.key === 'error.reloaded'), false);
});

test('a document-bound send repair cannot redirect a prompt to a replacement document', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  let boundDocumentId: string | undefined;
  app.holdSendAcknowledgements((message) => {
    boundDocumentId = message.documentId;
    app.setDocumentId(message.tabId, 'document-gemini-after-send-race');
    throw new Error('Could not establish connection. Receiving end does not exist.');
  });
  await app.send('free', ['gemini']);
  assert.equal(typeof boundDocumentId, 'string');
  assert.equal(app.sent.length, 1);
  const repair = app.scriptExecutions.find((injection) => Array.isArray(injection.files));
  assert.equal(repair?.target?.documentIds?.length, 1);
  assert.equal(repair?.target?.documentIds?.[0], boundDocumentId);
});

test('a replaced provider tab rejects its old bound request without sending a prompt to the replacement', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('free', ['gemini']);
  await waitUntil(() => app.sent.length === 1, 'bound Gemini request');
  const first = app.sent[0];
  assert.equal(typeof first.documentId, 'string');
  app.replaceTab(first.tabId, 99);
  await waitUntil(() => app.broadcasts.some((message) => decodeError(String(message.payload))?.key === 'error.reloaded'), 'tab replacement failure');
  assert.equal(app.sent.length, 1);
  await running;
  assert.equal(app.pendingResponseCount(), 0);
});

test('25 alternating Roundtable and Debate workflows keep isolated contexts and clean request state', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const startedAt = performance.now();
  const previousQuestions: string[] = [];
  let totalContributions = 0;
  const roundtable: RoundtableRoles = { first: 'chatgpt', second: 'claude', third: 'gemini', fourth: 'grok' };
  const debate: DebateRoles = { pro: 'chatgpt', con: 'claude', judge: 'gemini', summary: 'grok' };
  for (let run = 0; run < 25; run += 1) {
    const mode = run % 2 === 0 ? 'roundtable' : 'debate';
    const count = mode === 'roundtable' ? 20 : 4;
    const question = `REPEAT_RUN_${run + 1}_QUESTION;`;
    const start = app.sent.length;
    const workflowId = crypto.randomUUID();
    const running = app.send(mode, undefined, {
      workflowId, sessionId: `repeat-session-${run + 1}`, text: question,
      roles: mode === 'roundtable' ? roundtable : debate,
    });
    for (let turn = 0; turn < count; turn += 1) {
      await waitUntil(() => app.sent.length === start + turn + 1, `run ${run + 1}, turn ${turn + 1}`);
      const request = app.sent[start + turn];
      assert.equal(request.workflowId, workflowId);
      assert.equal(request.provider, ['chatgpt', 'claude', 'gemini', 'grok'][turn % 4]);
      assert.ok(request.payload.text.includes(question));
      for (const previousQuestion of previousQuestions) assert.equal(request.payload.text.includes(previousQuestion), false);
      for (let previousRun = 0; previousRun < run; previousRun += 1) {
        assert.equal(request.payload.text.includes(`RUN_${previousRun + 1}_ANSWER_`), false);
      }
      assert.doesNotMatch(request.payload.text, /\[Error:/);
      app.complete(request, `RUN_${run + 1}_ANSWER_${turn + 1};`);
    }
    assert.equal((await running).ok, true);
    assert.equal(app.pendingResponseCount(), 0);
    assert.equal(app.pendingTimerCount(), 0);
    assert.equal(app.session.multiAiActiveWorkflow, undefined);
    previousQuestions.push(question);
    totalContributions += count;
  }
  assert.equal(totalContributions, 308);
  assert.equal(app.sent.length, 308);
  assert.equal(app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), false);
  t.diagnostic(`25 sequential synthetic workflows, 308 contributions, ${(performance.now() - startedAt).toFixed(1)} ms`);
});

test('worker restores standby at startup and repairs default Coding roles before sending', async (t) => {
  const app = worker({ standbyProvider: 'grok' });
  t.after(app.close);
  await app.ready;
  await app.send('coding');
  assert.deepEqual(app.sent.map((message) => message.provider), [
    'gemini', 'chatgpt', 'claude', 'chatgpt', 'meta', 'claude', 'gemini', 'claude',
  ]);
});

test('provider selection rejects content-script requests and changes during an active workflow', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const change = { action: 'SET_STANDBY_PROVIDER', payload: { standbyProvider: 'grok' } };
  assert.equal((await app.command(change, { tab: { id: 5 } })).ok, false);
  const running = app.send();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(app.sent.length, 4);
  assert.equal((await app.command(change)).ok, false);
  for (const message of app.sent) app.complete(message);
  await running;
  assert.equal((await app.command(change)).ok, true);
});

test('Free worker sends only to Ready targets and records every selected unready display name', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, true, { chatgpt: false, claude: null, gemini: false });
  t.after(app.close);
  await app.ready;
  await app.send('free', ALL_PROVIDERS);
  assert.deepEqual(app.sent.map((message) => message.provider), ['meta']);
  const status = app.broadcasts.find((message) => message.payload?.key === 'workflow.free.partial');
  assert.equal(status?.payload.params.ready, 'Meta AI');
  assert.equal(status?.payload.params.providers, 'ChatGPT · Claude · Gemini');
  assert.equal(app.broadcasts.some((message) => message.provider === 'system'), false);
  assert.ok(app.broadcasts.some((message) => message.payload?.done === true));
});

test('Free worker names only the unready targets when a different provider is Ready', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, true, { chatgpt: false, claude: false });
  t.after(app.close);
  await app.ready;
  await app.send('free', ['claude', 'chatgpt', 'claude']);
  assert.equal(app.sent.length, 0);
  const error = app.broadcasts.find((message) => message.provider === 'system');
  assert.deepEqual(decodeError(error?.payload), {
    key: 'error.providers_not_ready', params: { providers: 'Claude · ChatGPT' },
  });
  assert.ok(app.broadcasts.some((message) => message.payload?.done === true));
});

test('Free worker does not warn about unselected or standby providers', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, true, { chatgpt: false, claude: false, gemini: false });
  t.after(app.close);
  await app.ready;
  await app.send('free', ['meta', 'grok']);
  assert.deepEqual(app.sent.map((message) => message.provider), ['meta']);
  assert.equal(app.broadcasts.some((message) => message.payload?.key === 'workflow.free.partial'), false);
  const status = app.broadcasts.find((message) => message.payload?.key === 'workflow.free');
  assert.equal(status?.payload.params.providers, 'Meta AI');
});

test('Free worker distinguishes an empty selection from providers that are not Ready', async (t) => {
  const app = worker();
  t.after(app.close);
  await app.ready;
  await app.send('free', []);
  assert.equal(app.sent.length, 0);
  const error = app.broadcasts.find((message) => message.provider === 'system');
  assert.equal(decodeError(error?.payload)?.key, 'error.no_selection');
});

test('shortcut uses OPEN_LOGIN to focus existing unready tabs without opening standby or Ready tabs', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, true, { chatgpt: false, claude: null, gemini: false });
  t.after(app.close);
  await app.ready;
  const failed = await openUnreadyProviders(ALL_PROVIDERS, 'grok', await app.command({ action: 'GET_CONNECTIONS' }), async (provider) => {
    assert.equal((await app.command({ action: 'OPEN_LOGIN', provider })).ok, true);
  });
  assert.deepEqual(failed, []);
  assert.deepEqual(app.navigated, [1, 2, 3]);
  assert.deepEqual(app.created, []);
  assert.equal(app.sent.length, 0);
});

test('shortcut opens a missing selected tab through the existing login URL', async (t) => {
  const app = worker({}, true, {}, ['grok']);
  t.after(app.close);
  await app.ready;
  const failed = await openUnreadyProviders(['chatgpt', 'grok', 'grok', 'meta'], 'meta', await app.command({ action: 'GET_CONNECTIONS' }), async (provider) => {
    assert.equal((await app.command({ action: 'OPEN_LOGIN', provider })).ok, true);
  });
  assert.deepEqual(failed, []);
  assert.deepEqual(app.navigated, []);
  assert.deepEqual(app.created.map((tab) => tab.url), [AI_PROVIDERS.grok.loginUrl]);
});

test('worker still rejects a provider that became standby after the shortcut snapshot', async (t) => {
  const app = worker({}, true, { grok: false });
  t.after(app.close);
  await app.ready;
  const connections = await app.command({ action: 'GET_CONNECTIONS' });
  assert.equal((await app.command({ action: 'SET_STANDBY_PROVIDER', payload: { standbyProvider: 'grok' } })).ok, true);
  const failed = await openUnreadyProviders(['grok'], 'meta', connections, async (provider) => {
    const result = await app.command({ action: 'OPEN_LOGIN', provider });
    if (!result.ok) throw new Error(result.error);
  });
  assert.deepEqual(failed, ['grok']);
  assert.deepEqual(app.navigated, []);
  assert.deepEqual(app.created, []);
});

test('Free sends only to ready-only targets and leaves other active providers unselected', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, true, { chatgpt: false, claude: null, gemini: false });
  t.after(app.close);
  await app.ready;
  const targets = readyActiveTargets(await app.command({ action: 'GET_CONNECTIONS' }), 'grok');
  assert.deepEqual(targets, ['meta']);
  await app.send('free', targets);
  assert.deepEqual(app.sent.map((message) => message.provider), ['meta']);
  assert.equal(app.broadcasts.some((message) => message.payload?.key === 'workflow.free.partial'), false);
  assert.equal(app.broadcasts.some((message) => message.provider === 'system'), false);
});

test('Free surfaces an undelivered Meta failure when another target still answers', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('free', ['chatgpt', 'meta']);
  await waitUntil(() => app.sent.length === 2, 'free fanout to ChatGPT and Meta');
  app.complete(app.sent.find((message) => message.provider === 'chatgpt'));
  const meta = app.sent.find((message) => message.provider === 'meta');
  app.removeTab(meta.tabId);
  await running;
  const metaError = app.broadcasts.find((message) => (
    message.action === 'RESPONSE_DONE' && message.provider === 'meta' && String(message.payload).includes('Error:')
  ));
  assert.equal(decodeError(String(metaError?.payload))?.key, 'error.tab_closed');
  assert.equal(app.broadcasts.some((message) => message.provider === 'system'), false);
  assert.ok(app.broadcasts.some((message) => message.payload?.done === true && message.payload?.cancelled !== true));
});

test('Free does not add a system error when every target already delivered [Error:]', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('free', ['chatgpt', 'meta']);
  await waitUntil(() => app.sent.length === 2, 'free fanout before delivered errors');
  for (const message of app.sent) app.fail(message, '[Error: quota]');
  await running;
  assert.equal(app.broadcasts.filter((message) => message.provider === 'system').length, 0);
  assert.equal(app.broadcasts.filter((message) => (
    message.action === 'RESPONSE_DONE' && String(message.payload).includes('Error:')
  )).length, 2);
  assert.ok(app.broadcasts.some((message) => message.payload?.done === true));
});

test('Free keeps a delivered [Error:] off the system channel when the other target answers', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('free', ['chatgpt', 'meta']);
  await waitUntil(() => app.sent.length === 2, 'free fanout before mixed delivered error');
  app.fail(app.sent.find((message) => message.provider === 'chatgpt'), '[Error: quota]');
  app.complete(app.sent.find((message) => message.provider === 'meta'));
  await running;
  assert.equal(app.broadcasts.filter((message) => message.provider === 'system').length, 0);
  assert.equal(app.broadcasts.filter((message) => (
    message.action === 'RESPONSE_DONE' && message.provider === 'chatgpt' && String(message.payload).includes('Error:')
  )).length, 1);
  assert.ok(app.broadcasts.some((message) => message.payload?.done === true && message.payload?.cancelled !== true));
});

test('Free all-fail reports only the undelivered Meta error as a system message', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('free', ['chatgpt', 'meta']);
  await waitUntil(() => app.sent.length === 2, 'free fanout before mixed all-fail');
  app.fail(app.sent.find((message) => message.provider === 'chatgpt'), '[Error: quota]');
  app.removeTab(app.sent.find((message) => message.provider === 'meta').tabId);
  await running;
  const systemErrors = app.broadcasts.filter((message) => message.provider === 'system');
  assert.equal(systemErrors.length, 1);
  assert.equal(decodeError(String(systemErrors[0]?.payload))?.key, 'error.tab_closed');
  assert.equal(app.broadcasts.filter((message) => (
    message.action === 'RESPONSE_DONE' && message.provider === 'chatgpt' && String(message.payload).includes('Error:')
  )).length, 1);
});

test('Debate with Meta as pro retries only its failed stage with a fresh request identity', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate', undefined, { roles: META_DEBATE });
  await waitUntil(() => app.sent.length === 1, 'Meta debate opening turn');
  assert.equal(app.sent[0].provider, 'meta');
  app.fail(app.sent[0], '[Error: quota]');
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'Debate recovery');
  const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal((await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'retry' } })).ok, true);
  await waitUntil(() => app.sent.length === 2, 'Debate retry');
  assert.notEqual(app.sent[0].requestId, app.sent[1].requestId);
  assert.equal(app.sent[0].payload.text, app.sent[1].payload.text);
  await completeRemaining(app, running);
  assert.deepEqual(app.sent.map((message) => message.provider), ['meta', 'meta', 'chatgpt', 'claude', 'gemini']);
  assert.ok(app.broadcasts.some((message) => (
    message.action === 'ROLE_ASSIGNMENT' && message.requestId === app.sent[1].requestId && message.payload?.labelKey === 'role.pro'
  )));
});

test('Debate honors the explicit Meta → Grok → Gemini → ChatGPT map and scopes each provider to its own contribution', async (t) => {
  const app = worker({ standbyProvider: 'claude' }, false);
  t.after(app.close);
  await app.ready;
  const roles: DebateRoles = { pro: 'meta', con: 'grok', judge: 'gemini', summary: 'chatgpt' };
  const topic = 'Should university students be allowed to use AI for assignments?';
  const running = app.send('debate', undefined, { roles, text: topic });
  const answers = ['META_OWN_PRO', 'GROK_OWN_CON', 'GEMINI_OWN_BALANCE', 'CHATGPT_OWN_AGREEMENT'];
  for (const [index, provider] of ['meta', 'grok', 'gemini', 'chatgpt'].entries()) {
    await waitUntil(() => app.sent.length === index + 1, `mapped Debate seat ${index + 1}`);
    const request = app.sent[index];
    assert.equal(request.provider, provider);
    assert.match(request.payload.text, new RegExp(`You are ${AI_PROVIDERS[provider as AIProvider].name}, the single`));
    assert.match(request.payload.text, /Return only your own contribution for this turn\./);
    assert.match(request.payload.text, /Do not simulate, invent, attribute, or prewrite contributions/);
    assert.match(request.payload.text, new RegExp(topic.replace(/[?]/g, '\\?')));
    if (index > 0) assert.match(request.payload.text, new RegExp(answers[index - 1]));
    app.complete(request, answers[index]);
  }
  assert.equal((await running).ok, true);
  const diagnostics = app.broadcasts.filter((message) => message.action === 'WORKFLOW_DIAGNOSTIC');
  for (const provider of ['meta', 'grok', 'gemini', 'chatgpt'] as AIProvider[]) {
    assert.ok(diagnostics.some((message) => (
      message.provider === provider && message.payload?.stage === 'prompt_constructed'
        && message.payload?.workflowId && message.payload?.turnId
    )), `${provider} prompt construction is traceable without prompt text`);
    assert.ok(diagnostics.some((message) => (
      message.provider === provider && message.payload?.stage === 'response_extracted'
        && typeof message.payload?.responseLength === 'number'
    )), `${provider} extraction is traceable without response text`);
  }
});

test('Consult serializes independent first seats so each request has one recovery owner', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('consult', undefined, { roles: META_CONSULT });
  await waitUntil(() => app.sent.length === 1, 'consult first seat');
  assert.equal(app.sent[0].provider, 'meta');
  app.complete(app.sent[0]);
  await waitUntil(() => app.sent.length === 2, 'consult second seat');
  assert.equal(app.sent[1].provider, 'chatgpt');
  assert.equal(app.sent.some((message) => message.provider === 'claude'), false);
  app.complete(app.sent[1]);
  await waitUntil(() => app.sent.some((message) => message.provider === 'claude'), 'consult reviewer');
  await completeRemaining(app, running);
  assert.deepEqual(app.sent.slice(0, 2).map((message) => message.provider), ['meta', 'chatgpt']);
  assert.deepEqual(app.sent.slice(2).map((message) => message.provider), ['claude', 'gemini']);
});

test('Roundtable worker retries a failed Meta turn with a fresh request id', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('roundtable', undefined, { roles: META_ROUNDTABLE });
  await waitUntil(() => app.sent.length === 1, 'Meta roundtable first send');
  assert.equal(app.sent[0].provider, 'meta');
  app.fail(app.sent[0]);
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'Meta recovery prompt');
  const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal(recovery.provider, 'meta');
  assert.equal((await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'retry' } })).ok, true);
  await waitUntil(() => app.stops.some((message) => message.provider === 'meta' && message.requestId === app.sent[0].requestId), 'scoped Meta stop');
  await waitUntil(() => app.sent.length === 2, 'Meta retry send');
  assert.equal(app.sent[1].provider, 'meta');
  assert.notEqual(app.sent[1].requestId, app.sent[0].requestId);
  assert.equal(app.sent[1].payload.text, app.sent[0].payload.text);
  await completeRemaining(app, running);
  assert.equal(app.sent.length, 21);
  assert.equal(app.sent.filter((message) => message.provider === 'meta').length, 6);
});

test('enabled Safe Automatic retries only a confirmed-unsent Roundtable insertion failure', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('roundtable', undefined, {
    roles: META_ROUNDTABLE,
    recovery: { enabled: true, policy: 'safe' },
  });
  await waitUntil(() => app.sent.length === 1, 'first safe automatic send');
  const first = app.sent[0];
  app.fail(first, '[Error: i18n:{"key":"error.input_not_found","params":{"provider":"meta"}}]');
  await waitUntil(() => app.sent.length === 2, 'bounded automatic retry', 4_000);
  assert.equal(app.sent[1].provider, 'meta');
  assert.notEqual(app.sent[1].requestId, first.requestId);
  assert.equal(app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), false);
  assert.ok(app.broadcasts.some((message) => message.payload?.key === 'workflow.recovering'));
  await completeRemaining(app, running);
  assert.equal(app.sent.length, 21);
});

for (const mode of ['debate', 'roundtable'] as const) {
  test(`${mode} ignores responses from the wrong request, provider, workflow, tab or URL`, async (t) => {
    const app = worker({}, false);
    t.after(app.close);
    await app.ready;
    const roles = mode === 'debate'
      ? { pro: 'chatgpt', con: 'claude', judge: 'gemini', summary: 'grok' } as DebateRoles
      : { first: 'chatgpt', second: 'claude', third: 'gemini', fourth: 'grok' } as RoundtableRoles;
    const running = app.send(mode, undefined, { roles });
    await waitUntil(() => app.sent.length === 1, 'first turn');
    const first = app.sent[0];
    const original = { ...first, action: 'RESPONSE_DONE', payload: 'unattributed response' };
    for (const action of ['RESPONSE_CHUNK', 'RESPONSE_DONE']) {
      app.receive({ ...original, action, requestId: 'old-request' }, { tab: { id: first.tabId, url: AI_PROVIDERS.chatgpt.url } });
      app.receive({ ...original, action, provider: 'claude' }, { tab: { id: first.tabId, url: AI_PROVIDERS.chatgpt.url } });
      app.receive({ ...original, action, workflowId: crypto.randomUUID() }, { tab: { id: first.tabId, url: AI_PROVIDERS.chatgpt.url } });
      app.receive({ ...original, action }, { tab: { id: first.tabId + 10, url: AI_PROVIDERS.chatgpt.url } });
      app.receive({ ...original, action }, { tab: { id: first.tabId, url: 'https://example.com/' } });
      app.receive({ ...original, action }, {});
    }
    await flushWorkerTurns();
    assert.equal(app.sent.length, 1);
    assert.equal(app.broadcasts.some((message) => message.payload === original.payload), false);
    app.receive({ ...original, action: 'RESPONSE_CHUNK', payload: 'current partial' }, { tab: { id: first.tabId, url: AI_PROVIDERS.chatgpt.url } });
    app.complete(first, 'current answer');
    app.complete(first, 'duplicate answer');
    await waitUntil(() => app.sent.length === 2, 'second turn');
    assert.match(app.sent[1].payload.text, /current answer/);
    assert.doesNotMatch(app.sent[1].payload.text, /unattributed response/);
    assert.deepEqual(app.broadcasts.filter((message) => message.requestId === first.requestId && /^RESPONSE_/.test(message.action)).map((message) => message.payload), ['current partial', 'current answer']);
    app.complete(first, 'late answer');
    await flushWorkerTurns();
    assert.equal(app.broadcasts.some((message) => message.payload === 'late answer'), false);
    assert.equal(app.broadcasts.some((message) => message.payload === 'duplicate answer'), false);
    await completeRemaining(app, running);
    assert.equal(app.sent.length, mode === 'debate' ? 4 : 20);
  });
}

test('accepted response chunks and completion are relayed in order before the next Debate stage', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate');
  await waitUntil(() => app.sent.length === 1, 'first turn');
  const first = app.sent[0];
  let release: (() => void) | undefined;
  let held = false;
  app.holdBroadcasts(async (message) => {
    if (message.action !== 'RESPONSE_CHUNK') return;
    held = true;
    await new Promise<void>((resolve) => { release = resolve; });
  });
  app.receive({ ...first, action: 'RESPONSE_CHUNK', payload: 'partial' }, { tab: { id: first.tabId, url: AI_PROVIDERS[first.provider as AIProvider].url } });
  app.complete(first, 'final');
  await waitUntil(() => held, 'response relay held');
  await flushWorkerTurns();
  assert.equal(app.sent.length, 1);
  release?.();
  app.holdBroadcasts();
  await waitUntil(() => app.sent.length === 2, 'next Debate stage');
  const responseActions = app.broadcasts.filter((message) => message.requestId === first.requestId && /^RESPONSE_/.test(message.action));
  assert.deepEqual(responseActions.map((message) => message.action), ['RESPONSE_CHUNK', 'RESPONSE_DONE']);
  await completeRemaining(app, running);
});

for (const failedAt of [1, 2, 3, 4]) {
  test(`Debate skips failed stage ${failedAt} without forwarding its quota error`, async (t) => {
    const app = worker({}, false);
    t.after(app.close);
    await app.ready;
    const running = app.send('debate');
    for (let index = 0; index < failedAt - 1; index += 1) {
      await waitUntil(() => app.sent.length > index, 'prior Debate stage');
      app.complete(app.sent[index], `argument-${index + 1}`);
    }
    await waitUntil(() => app.sent.length === failedAt, 'failed Debate stage');
    app.fail(app.sent[failedAt - 1], '[Error: explicit quota failure]');
    await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'Debate skip recovery');
    const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
    assert.equal((await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'skip' } })).ok, true);
    await completeRemaining(app, running);
    assert.equal(app.sent.length, 4);
    assert.equal(app.sent.slice(failedAt).some((message) => /explicit quota failure/.test(message.payload.text)), false);
    if (failedAt < 4) assert.match(app.sent[failedAt].payload.text, /no response.*skipped/);
  });
}

test('Debate recovery cancel stops the failed stage and does not start another provider', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate');
  await waitUntil(() => app.sent.length === 1, 'Debate before cancel');
  app.fail(app.sent[0]);
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'Debate cancel recovery');
  const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal((await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'cancel' } })).ok, true);
  await running;
  assert.equal(app.sent.length, 1);
  assert.ok(app.stops.some((message) => message.requestId === app.sent[0].requestId && message.workflowId === app.sent[0].workflowId));
  assert.ok(app.broadcasts.some((message) => message.payload?.done && message.payload?.cancelled));
});

test('old workflow cleanup cannot erase a new session workflow marker', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const first = app.send('free', ['chatgpt']);
  await waitUntil(() => app.sent.length === 1, 'first request');
  let release: (() => void) | undefined;
  let held = 0;
  app.holdSessionGets(async () => {
    held += 1;
    if (held === 1) await new Promise<void>((resolve) => { release = resolve; });
  });
  app.complete(app.sent[0]);
  await waitUntil(() => held === 1, 'old marker cleanup read');
  const secondId = crypto.randomUUID();
  const second = app.send('free', ['claude'], { workflowId: secondId, sessionId: 'new-session' });
  await flushWorkerTurns();
  release?.();
  app.holdSessionGets();
  await waitUntil(() => app.sent.length === 2, 'new session request');
  await first;
  assert.equal((app.session.multiAiActiveWorkflow as { workflowId?: string } | undefined)?.workflowId, secondId);
  await completeRemaining(app, second);
});

test('an empty Debate completion opens recovery rather than becoming an argument', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate');
  await waitUntil(() => app.sent.length === 1, 'Debate before empty completion');
  app.complete(app.sent[0], '  ');
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'empty completion recovery');
  assert.equal(app.sent.length, 1);
  const diagnostics = app.broadcasts.filter((message) => message.action === 'WORKFLOW_DIAGNOSTIC');
  assert.equal(diagnostics.some((message) => message.payload?.stage === 'response_extracted'), false);
  assert.ok(diagnostics.some((message) => (
    message.payload?.stage === 'response_error'
      && message.payload?.failureCode === 'error.no_response_text'
      && message.payload?.failureKind === 'response_extraction'
      && message.payload?.responseLength === undefined
  )), 'an encoded no-response envelope is recorded as an error, never an extracted response');
  const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal(decodeError(recovery.reason)?.key, 'error.no_response_text');
  assert.equal((await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'cancel' } })).ok, true);
  await running;
});

test('cancelling during a held response relay stops its exact request without advancing Debate', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate');
  await waitUntil(() => app.sent.length === 1, 'Debate request before held relay');
  const first = app.sent[0];
  let release: (() => void) | undefined;
  let held = false;
  app.holdBroadcasts(async (message) => {
    if (message.action !== 'RESPONSE_CHUNK') return;
    held = true;
    await new Promise<void>((resolve) => { release = resolve; });
  });
  app.receive({ ...first, action: 'RESPONSE_CHUNK', payload: 'partial' }, { tab: { id: first.tabId, url: AI_PROVIDERS[first.provider as AIProvider].url } });
  app.complete(first, 'final');
  await waitUntil(() => held, 'chunk relay held');
  assert.equal((await app.command({ action: 'CANCEL_WORKFLOW', payload: {
    workflowId: first.workflowId, sessionId: 'session', clientId: 'client',
  } })).ok, true);
  await running;
  release?.();
  app.holdBroadcasts();
  await flushWorkerTurns();
  assert.equal(app.sent.length, 1);
  assert.ok(app.stops.some((message) => message.requestId === first.requestId));
  assert.equal(app.broadcasts.some((message) => message.action === 'RESPONSE_DONE' && message.requestId === first.requestId), false);
});

test('Roundtable runs five ordered rounds of four seats and a later Debate has fresh prompt history', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const roles: RoundtableRoles = { first: 'chatgpt', second: 'claude', third: 'gemini', fourth: 'grok' };
  const running = app.send('roundtable', undefined, { roles, text: 'ROUND_TABLE_QUESTION' });
  const participants = Object.values(roles);
  for (let index = 0; index < 20; index += 1) {
    await waitUntil(() => app.sent.length === index + 1, `Roundtable logical turn ${index + 1}`);
    const request = app.sent[index];
    assert.equal(request.provider, participants[index % 4]);
    assert.match(request.payload.text, /ROUND_TABLE_QUESTION/);
    for (let previous = 0; previous < index; previous += 1) {
      assert.ok(request.payload.text.includes(`round-answer-${previous + 1};`));
    }
    assert.equal(request.payload.text.includes(`round-answer-${index + 1};`), false);
    const assignment = app.broadcasts.find((message) => message.action === 'ROLE_ASSIGNMENT' && message.requestId === request.requestId);
    assert.equal(assignment?.payload?.labelKey, `round.${Math.floor(index / 4) + 1}`);
    app.complete(request, `round-answer-${index + 1};`);
  }
  await running;
  assert.equal(new Set(app.sent.map((message) => message.requestId)).size, 20);
  const debating = app.send('debate', undefined, { text: 'DEBATE_ONLY_QUESTION', sessionId: 'other-session' });
  await completeRemaining(app, debating);
  assert.equal(app.sent.length, 24);
  for (const request of app.sent.slice(20)) {
    assert.match(request.payload.text, /DEBATE_ONLY_QUESTION/);
    assert.doesNotMatch(request.payload.text, /ROUND_TABLE_QUESTION|round-answer-/);
  }
});

test('ordinary provider prose about quota is forwarded as an argument without recovery', async (t) => {
  const app = worker({}, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate');
  await waitUntil(() => app.sent.length === 1, 'Debate before quota policy argument');
  app.complete(app.sent[0], 'A fair quota policy can reduce congestion.');
  await waitUntil(() => app.sent.length === 2, 'Con receives ordinary quota prose');
  assert.match(app.sent[1].payload.text, /A fair quota policy can reduce congestion\./);
  assert.equal(app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), false);
  await completeRemaining(app, running);
});

test('Roundtable worker skip and cancel keep Meta errors out of later prompts', async (t) => {
  const skip = worker({ standbyProvider: 'grok' }, false);
  t.after(skip.close);
  await skip.ready;
  const skipping = skip.send('roundtable', undefined, { roles: META_ROUNDTABLE, text: 'Skip me' });
  await waitUntil(() => skip.sent.length === 1, 'Meta skip first send');
  skip.fail(skip.sent[0], '[Error: meta quota]');
  await waitUntil(() => skip.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'Meta skip recovery');
  const skipRecovery = skip.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal((await skip.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...skipRecovery, action: 'skip' } })).ok, true);
  await completeRemaining(skip, skipping);
  assert.equal(skip.sent.length, 20);
  assert.equal(skip.sent.filter((message) => message.provider === 'meta').length, 5);
  assert.equal(skip.sent.some((message) => String(message.payload?.text).includes('meta quota')), false);

  const cancel = worker({ standbyProvider: 'grok' }, false);
  t.after(cancel.close);
  await cancel.ready;
  const cancelling = cancel.send('roundtable', undefined, { roles: META_ROUNDTABLE });
  await waitUntil(() => cancel.sent.length === 1, 'Meta cancel first send');
  cancel.fail(cancel.sent[0]);
  await waitUntil(() => cancel.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'Meta cancel recovery');
  const cancelRecovery = cancel.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal((await cancel.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...cancelRecovery, action: 'cancel' } })).ok, true);
  await cancelling;
  assert.equal(cancel.sent.length, 1);
  assert.ok(cancel.stops.some((message) => message.provider === 'meta'));
  assert.ok(cancel.broadcasts.some((message) => message.payload?.done === true && message.payload?.cancelled === true));
});

test('CANCEL_WORKFLOW stops an in-flight Meta debate and ignores a late RESPONSE_DONE', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate', undefined, { roles: META_DEBATE });
  await waitUntil(() => app.sent.length === 1, 'Meta debate send before cancel');
  const workflowId = app.sent[0].workflowId;
  assert.equal((await app.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId, sessionId: 'session', clientId: 'client' },
  })).ok, true);
  await running;
  assert.equal(app.sent.length, 1);
  assert.ok(app.stops.some((message) => message.provider === 'meta' && message.workflowId === workflowId));
  const doneCount = app.broadcasts.filter((message) => message.payload?.done === true).length;
  app.complete(app.sent[0]);
  assert.equal(app.sent.length, 1);
  assert.equal(app.broadcasts.filter((message) => message.payload?.done === true).length, doneCount);
  assert.equal((await app.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId, sessionId: 'session', clientId: 'client' },
  }, { tab: { id: 5 } })).ok, false);
});

test('panel reconnect rebinds a live Meta debate so the new client can cancel', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate', undefined, { roles: META_DEBATE });
  await waitUntil(() => app.sent.length === 1 && app.sent[0].provider === 'meta', 'Meta debate before reconnect');
  const workflowId = app.sent[0].workflowId;
  await app.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
  await waitUntil(() => app.broadcasts.some((message) => (
    message.action === 'WORKFLOW_STATUS' && message.payload?.clientId === 'panel-2' && !message.payload?.done
  )), 'replayed status for the new panel');
  assert.ok(app.broadcasts.some((message) => (
    message.action === 'ROLE_ASSIGNMENT' && message.provider === 'meta' && message.payload?.clientId === 'panel-2'
  )));
  assert.equal((await app.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId, sessionId: 'session', clientId: 'client' },
  })).ok, false);
  assert.equal((await app.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId, sessionId: 'session', clientId: 'panel-2' },
  })).ok, true);
  await running;
  assert.equal(app.sent.length, 1);
  assert.ok(app.stops.some((message) => message.provider === 'meta'));
});

test('finishing a Meta debate during panel replay does not emit a stale role', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate', undefined, { roles: META_DEBATE });
  await waitUntil(() => (
    app.sent.length === 1 && app.broadcasts.some((message) => message.action === 'ROLE_ASSIGNMENT' && message.provider === 'meta')
  ), 'Meta debate role before reconnect');
  const workflowId = app.sent[0].workflowId;
  const requestId = app.sent[0].requestId;
  let releaseReplay: (() => void) | undefined;
  let held = 0;
  app.holdBroadcasts(async (message) => {
    if (message.action === 'WORKFLOW_STATUS' && message.payload?.clientId === 'panel-2' && !message.payload?.done) {
      held += 1;
      await new Promise<void>((resolve) => { releaseReplay = resolve; });
    }
  });
  const reconnect = app.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
  await waitUntil(() => held === 1, 'live status replay held');
  assert.equal((await app.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId, sessionId: 'session', clientId: 'panel-2' },
  })).ok, true);
  await running;
  const rolesBeforeRelease = app.broadcasts.filter((message) => message.action === 'ROLE_ASSIGNMENT').length;
  releaseReplay?.();
  app.holdBroadcasts();
  await reconnect;
  await flushWorkerTurns();
  const rolesAfter = app.broadcasts.filter((message) => message.action === 'ROLE_ASSIGNMENT').slice(rolesBeforeRelease);
  assert.equal(rolesAfter.some((message) => message.payload?.clientId === 'panel-2'), false);
  assert.equal(app.broadcasts.some((message) => (
    message.action === 'ROLE_ASSIGNMENT' && (!message.workflowId || (message.requestId === requestId && message.workflowId !== workflowId))
  )), false);
});

test('replacing a Meta debate during panel replay keeps the old role out of the new workflow', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const firstId = crypto.randomUUID();
  const first = app.send('debate', undefined, { roles: META_DEBATE, workflowId: firstId });
  await waitUntil(() => (
    app.sent.length === 1 && app.sent[0].workflowId === firstId
  ), 'first Meta debate send');
  const firstRequestId = app.sent[0].requestId;
  let releaseReplay: (() => void) | undefined;
  let held = 0;
  app.holdBroadcasts(async (message) => {
    if (
      message.action === 'WORKFLOW_STATUS'
      && message.payload?.clientId === 'panel-2'
      && !message.payload?.done
      && message.payload?.workflowId === firstId
    ) {
      held += 1;
      await new Promise<void>((resolve) => { releaseReplay = resolve; });
    }
  });
  const reconnect = app.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
  await waitUntil(() => held === 1, 'live status replay held');
  const secondId = crypto.randomUUID();
  const second = app.send('debate', undefined, {
    roles: { pro: 'chatgpt', con: 'claude', judge: 'gemini', summary: 'meta' },
    workflowId: secondId,
    clientId: 'panel-2',
  });
  await waitUntil(() => app.sent.some((message) => message.workflowId === secondId), 'replacement debate started');
  releaseReplay?.();
  app.holdBroadcasts();
  await reconnect;
  await first;
  await completeRemaining(app, second);
  assert.equal(app.broadcasts.some((message) => (
    message.action === 'ROLE_ASSIGNMENT'
    && message.workflowId === secondId
    && message.requestId === firstRequestId
  )), false);
  assert.equal(app.broadcasts.some((message) => (
    message.action === 'WORKFLOW_STATUS'
    && message.payload?.workflowId === secondId
    && message.payload?.key === 'workflow.debate.pro'
    && message.payload?.params?.provider === 'Meta AI'
  )), false);
});

test('simultaneous reconnect replays a live Meta debate only to the latest client', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate', undefined, { roles: META_DEBATE });
  await waitUntil(() => app.sent.length === 1 && app.sent[0].provider === 'meta', 'Meta debate before simultaneous reconnect');
  const workflowId = app.sent[0].workflowId;
  await app.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
  await app.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-3', sessionId: 'session' } });
  await waitUntil(() => app.broadcasts.some((message) => (
    message.action === 'WORKFLOW_STATUS' && message.payload?.clientId === 'panel-3' && !message.payload?.done
  )), 'replayed status for the latest panel');
  assert.ok(app.broadcasts.some((message) => (
    message.payload?.clientId === 'panel-2' && message.payload?.done === true && message.payload?.cancelled === true
  )));
  assert.ok(app.broadcasts.some((message) => (
    message.action === 'ROLE_ASSIGNMENT' && message.provider === 'meta' && message.payload?.clientId === 'panel-3'
  )));
  assert.equal((await app.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId, sessionId: 'session', clientId: 'panel-2' },
  })).ok, false);
  assert.equal((await app.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId, sessionId: 'session', clientId: 'panel-3' },
  })).ok, true);
  await running;
  assert.ok(app.stops.some((message) => message.provider === 'meta'));
});

test('panel reconnect during Meta recovery rotates the decision identity', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('roundtable', undefined, { roles: META_ROUNDTABLE });
  await waitUntil(() => app.sent.length === 1, 'Meta recovery before reconnect');
  app.fail(app.sent[0]);
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'original Meta recovery');
  const original = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  await app.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
  await waitUntil(() => app.broadcasts.some((message) => (
    message.action === 'STEP_RECOVERY_REQUIRED' && message.payload?.clientId === 'panel-2'
  )), 'rebound Meta recovery');
  const rebound = [...app.broadcasts].reverse().find((message) => (
    message.action === 'STEP_RECOVERY_REQUIRED' && message.payload?.clientId === 'panel-2'
  ))!.payload;
  assert.notEqual(rebound.recoveryId, original.recoveryId);
  assert.equal((await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...original, action: 'retry' } })).ok, false);
  assert.equal((await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...rebound, action: 'skip' } })).ok, true);
  await completeRemaining(app, running);
  assert.equal(app.sent.length, 20);
});

test('only the current panel can acknowledge a scoped recovery prompt', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('roundtable', undefined, { roles: META_ROUNDTABLE });
  await waitUntil(() => app.sent.length === 1, 'Meta recovery receipt setup');
  app.fail(app.sent[0]);
  await waitUntil(() => app.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'Meta recovery receipt');
  const recovery = app.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal((await app.command({
    action: 'STEP_RECOVERY_PRESENTED', payload: { ...recovery, clientId: 'stale-panel' },
  })).ok, false);
  assert.equal((await app.command({ action: 'STEP_RECOVERY_PRESENTED', payload: recovery })).ok, true);
  assert.equal((await app.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'skip' } })).ok, true);
  await completeRemaining(app, running);
});

async function flushWorkerTurns(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('granting meta host access registers one persistent content script and does not register twice', async (t) => {
  const app = worker();
  t.after(app.close);
  await app.ready;
  assert.equal(app.dynamicScripts.length, 0);
  app.grantMetaHostAccess(true);
  app.permissions.onAdded.listeners[0]({ origins: [...META_ORIGINS] });
  await waitUntil(() => app.dynamicScripts.length === 1, 'meta content script registered');
  assert.equal(app.dynamicScripts[0].id, META_CONTENT_SCRIPT_ID);
  assert.equal(app.dynamicScripts[0].persistAcrossSessions, true);
  assert.deepEqual(app.dynamicScripts[0].matches, [...META_ORIGINS]);
  assert.deepEqual(app.dynamicScripts[0].js, ['content/meta.js']);
  assert.equal(app.dynamicScripts[0].runAt, 'document_idle');
  app.permissions.onAdded.listeners[0]({ origins: [...META_ORIGINS] });
  await flushWorkerTurns();
  assert.equal(app.dynamicScripts.length, 1);
  assert.deepEqual(app.contentScriptErrors, []);
});

test('removing meta host access unregisters only the meta script and restores the original four', async (t) => {
  const app = worker({
    standbyProvider: 'grok',
    freeTargets: ['chatgpt', 'claude', 'gemini', 'meta'],
  });
  t.after(app.close);
  await app.ready;
  app.dynamicScripts.push({ id: 'chatgpt-extra', js: ['content/chatgpt.js'] });
  app.grantMetaHostAccess(true);
  app.permissions.onAdded.listeners[0]({ origins: [...META_ORIGINS] });
  await waitUntil(() => app.dynamicScripts.some((script) => script.id === META_CONTENT_SCRIPT_ID), 'meta script registered');
  app.grantMetaHostAccess(false);
  app.permissions.onRemoved.listeners[0]({ origins: [...META_ORIGINS] });
  await waitUntil(() => app.local.standbyProvider === 'meta', 'standby reset to meta');
  assert.equal(app.dynamicScripts.some((script) => script.id === META_CONTENT_SCRIPT_ID), false);
  assert.equal(app.dynamicScripts.some((script) => script.id === 'chatgpt-extra'), true);
  assert.deepEqual(Array.from(app.local.freeTargets as string[]), ['chatgpt', 'claude', 'gemini', 'grok']);
  const updates = app.broadcasts.filter((message) => message.action === 'PROVIDER_SELECTION_UPDATE');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.standbyProvider, 'meta');
  assert.deepEqual(Array.from(updates[0].payload.freeTargets as string[]), ['chatgpt', 'claude', 'gemini', 'grok']);
  assert.deepEqual(app.contentScriptErrors, []);
});

test('removing meta host access is a no-op when Meta is already standby', async (t) => {
  const app = worker({ standbyProvider: 'meta', freeTargets: ['chatgpt', 'claude', 'gemini', 'grok'] });
  t.after(app.close);
  await app.ready;
  app.permissions.onRemoved.listeners[0]({ origins: [...META_ORIGINS] });
  await flushWorkerTurns();
  assert.equal(app.local.standbyProvider, 'meta');
  assert.deepEqual(app.local.freeTargets, ['chatgpt', 'claude', 'gemini', 'grok']);
  assert.equal(app.broadcasts.some((message) => message.action === 'PROVIDER_SELECTION_UPDATE'), false);
});

test('removing an unrelated host does not reset an active Meta seat', async (t) => {
  const app = worker({ standbyProvider: 'grok', freeTargets: ['chatgpt', 'claude', 'gemini', 'meta'] });
  t.after(app.close);
  await app.ready;
  app.permissions.onRemoved.listeners[0]({ origins: ['https://api.hackmd.io/*'] });
  await flushWorkerTurns();
  assert.equal(app.local.standbyProvider, 'grok');
  assert.deepEqual(app.local.freeTargets, ['chatgpt', 'claude', 'gemini', 'meta']);
  assert.equal(app.broadcasts.some((message) => message.action === 'PROVIDER_SELECTION_UPDATE'), false);
});

test('a replacement worker resumes a Roundtable checkpoint from an owned completed response', async (t) => {
  const first = worker({ standbyProvider: 'grok' }, false);
  t.after(first.close);
  await first.ready;
  const running = first.send('roundtable', undefined, { roles: META_ROUNDTABLE });
  void running.catch(() => {});
  await waitUntil(() => first.sent.length === 1, 'checkpointed Meta opening turn');
  const checkpointStore = { ...first.local };
  const markerStore = { ...first.session };
  const checkpoint = checkpointStore.multiAiWorkflowCheckpoint as { current?: { requestId?: string; turnKey?: string } } | undefined;
  assert.equal(checkpoint?.current?.requestId, first.sent[0].requestId);
  assert.equal(checkpoint?.current?.turnKey, 'roundtable:1:0');

  const second = worker(checkpointStore, false, {}, [], {
    session: markerStore,
    resumeSnapshot: { state: 'response_complete', submission: 'submitted', response: 'restored English opening' },
  });
  t.after(second.close);
  await second.ready;
  await second.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
  await waitUntil(() => second.sent.length === 1, 'second participant after resume');
  assert.equal(second.sent[0].provider, 'chatgpt');
  assert.ok(second.broadcasts.some((message) => (
    message.action === 'RESPONSE_DONE' && message.payload === 'restored English opening'
  )));
  assert.equal(second.broadcasts.some((message) => decodeError(String(message.payload))?.key === 'error.worker_stopped'), false);
  const completed = new Set<string>();
  await waitUntil(() => {
    for (const message of second.sent) {
      if (!message.requestId || completed.has(message.requestId)) continue;
      completed.add(message.requestId);
      second.complete(message);
    }
    return second.broadcasts.some((message) => message.payload?.done === true && message.payload?.cancelled === false);
  }, 'resumed Roundtable completion', 8_000);
  assert.equal(second.sent.length, 19);
});

test('a restart never replays a checkpoint whose accepted-send evidence outlives the content script', async (t) => {
  const first = worker({ standbyProvider: 'grok' }, false);
  t.after(first.close);
  await first.ready;
  const running = first.send('roundtable', undefined, { roles: META_ROUNDTABLE });
  void running.catch(() => {});
  await waitUntil(() => first.sent.length === 1, 'Roundtable request with persisted evidence');
  const checkpointStore = structuredClone(first.local) as Record<string, any>;
  checkpointStore.multiAiWorkflowCheckpoint.current.submission = 'submitted';
  checkpointStore.multiAiWorkflowCheckpoint.current.state = 'submission_accepted';
  const second = worker(checkpointStore, false, {}, [], { session: { ...first.session } });
  t.after(second.close);
  await second.ready;
  await second.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
  await waitUntil(() => second.broadcasts.some((message) => message.action === 'STEP_RECOVERY_REQUIRED'), 'manual recovery for ambiguous restored send');
  const recovery = second.broadcasts.find((message) => message.action === 'STEP_RECOVERY_REQUIRED')!.payload;
  assert.equal(recovery.retryAllowed, false);
  assert.equal(second.sent.length, 0);
  assert.equal((await second.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'retry' } })).ok, false);
  assert.equal((await second.command({ action: 'RESOLVE_STEP_RECOVERY', payload: { ...recovery, action: 'cancel' } })).ok, true);
  await waitUntil(() => second.broadcasts.some((message) => message.payload?.done === true && message.payload?.cancelled === true), 'restored cancellation');
});

test('a replacement worker tells the reopened panel that a Meta workflow was interrupted', async (t) => {
  const first = worker({ standbyProvider: 'grok' }, false);
  t.after(first.close);
  await first.ready;
  const running = first.send('debate', undefined, { roles: META_DEBATE });
  await waitUntil(() => first.sent.length === 1, 'Meta debate before worker replacement');
  const snapshot = { ...first.session };
  assert.ok(snapshot.multiAiActiveWorkflow);
  assert.equal((await first.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId: first.sent[0].workflowId, sessionId: 'session', clientId: 'client' },
  })).ok, true);
  await running;
  const second = worker({ standbyProvider: 'grok' }, true, {}, [], { session: snapshot });
  t.after(second.close);
  await second.ready;
  await second.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
  await waitUntil(() => second.broadcasts.some((message) => message.payload?.key === 'workflow.interrupted'), 'interrupted status');
  assert.equal(decodeError(second.broadcasts.find((message) => message.provider === 'system')?.payload)?.key, 'error.worker_stopped');
  assert.ok(second.broadcasts.some((message) => (
    message.payload?.done === true && message.payload?.cancelled === false && message.payload?.clientId === 'panel-2'
  )));
});

test('a Send started during interrupted-workflow lookup keeps the new run marker', async (t) => {
  const interruptedId = crypto.randomUUID();
  const app = worker({ standbyProvider: 'grok' }, false, {}, [], {
    session: {
      multiAiActiveWorkflow: {
        workflowId: interruptedId,
        sessionId: 'session',
        clientId: 'client',
        startedAt: 1,
      },
    },
  });
  t.after(app.close);
  await app.ready;
  let releaseGet: (() => void) | undefined;
  let heldGets = 0;
  app.holdSessionGets(async () => {
    heldGets += 1;
    if (heldGets > 1) return;
    await new Promise<void>((resolve) => { releaseGet = resolve; });
  });
  const nextId = crypto.randomUUID();
  let running: Promise<unknown> | undefined;
  try {
    void app.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
    await waitUntil(() => heldGets === 1, 'interrupted workflow lookup held');
    running = app.send('free', ['meta'], { workflowId: nextId, clientId: 'panel-2' });
    await flushWorkerTurns();
    releaseGet?.();
    releaseGet = undefined;
    app.holdSessionGets();
    await waitUntil(
      () => (app.session.multiAiActiveWorkflow as { workflowId?: string } | undefined)?.workflowId === nextId,
      'new workflow persisted after serialized lookup',
    );
    assert.equal(
      (app.session.multiAiActiveWorkflow as { workflowId?: string } | undefined)?.workflowId,
      nextId,
    );
  } finally {
    releaseGet?.();
    app.holdSessionGets();
    await flushWorkerTurns();
    if (running) {
      const pending = app.sent.find((message) => message.workflowId === nextId);
      if (pending) app.complete(pending);
      else {
        await app.command({
          action: 'CANCEL_WORKFLOW',
          payload: { workflowId: nextId, sessionId: 'session', clientId: 'panel-2' },
        });
      }
      await running;
    }
  }
});

test('default standby still repairs Meta out of Debate roles and leaves its tab untouched', async (t) => {
  const app = worker();
  t.after(app.close);
  await app.ready;
  await app.send('debate', undefined, { roles: META_DEBATE });
  assert.equal(app.sent.some((message) => message.provider === 'meta'), false);
  assert.deepEqual(app.sent.map((message) => message.provider), ['grok', 'chatgpt', 'claude', 'gemini']);
  await app.command({ action: 'RESET_PROVIDER_SESSIONS' });
  assert.equal(app.navigated.includes(5), false);
});

test('late Meta RESPONSE_DONE after Free completion does not restart the worker', async (t) => {
  const app = worker({ standbyProvider: 'grok' });
  t.after(app.close);
  await app.ready;
  await app.send('free', ['meta']);
  const doneCount = app.broadcasts.filter((message) => message.payload?.done === true).length;
  app.complete(app.sent[0]);
  assert.equal(app.sent.length, 1);
  assert.equal(app.broadcasts.filter((message) => message.payload?.done === true).length, doneCount);
});

test('GET_CONNECTIONS after a finished Meta debate does not replay status or roles', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate', undefined, { roles: META_DEBATE });
  await waitUntil(() => app.sent.length === 1, 'Meta debate before finish');
  await completeRemaining(app, running);
  const before = app.broadcasts.length;
  await app.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'panel-2', sessionId: 'session' } });
  const extra = app.broadcasts.slice(before);
  assert.equal(extra.some((message) => message.action === 'ROLE_ASSIGNMENT' && message.payload?.clientId === 'panel-2'), false);
  assert.equal(extra.some((message) => (
    message.action === 'WORKFLOW_STATUS' && message.payload?.clientId === 'panel-2' && !message.payload?.done
  )), false);
});

function selectionUpdates(app: { broadcasts: { action?: string; payload?: { standbyProvider?: string; freeTargets?: string[] } }[] }) {
  return app.broadcasts.filter((message) => message.action === 'PROVIDER_SELECTION_UPDATE');
}

test('absent meta permission resets standby grok to meta when the worker starts', async (t) => {
  const app = worker({
    standbyProvider: 'grok',
    freeTargets: ['chatgpt', 'claude', 'gemini', 'meta'],
  }, true, {}, [], { metaHostPermitted: false });
  t.after(app.close);
  await app.ready;
  await waitUntil(() => app.local.standbyProvider === 'meta', 'startup standby reset');
  assert.deepEqual(Array.from(app.local.freeTargets as string[]), ['chatgpt', 'claude', 'gemini', 'grok']);
  assert.equal(app.dynamicScripts.some((script) => script.id === META_CONTENT_SCRIPT_ID), false);
  const updates = selectionUpdates(app);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload?.standbyProvider, 'meta');
  assert.deepEqual(Array.from(updates[0].payload?.freeTargets ?? []), ['chatgpt', 'claude', 'gemini', 'grok']);
});

test('onStartup resets standby when meta permission disappeared without an onRemoved event', async (t) => {
  const app = worker({
    standbyProvider: 'grok',
    freeTargets: ['chatgpt', 'claude', 'gemini', 'meta'],
  });
  t.after(app.close);
  await app.ready;
  assert.equal(app.local.standbyProvider, 'grok');
  assert.equal(selectionUpdates(app).length, 0);
  app.grantMetaHostAccess(false);
  app.runtime.onStartup.listeners[0]();
  app.runtime.onStartup.listeners[0]();
  await waitUntil(() => app.local.standbyProvider === 'meta', 'onStartup standby reset');
  await flushWorkerTurns();
  assert.deepEqual(Array.from(app.local.freeTargets as string[]), ['chatgpt', 'claude', 'gemini', 'grok']);
  const updates = selectionUpdates(app);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload?.standbyProvider, 'meta');
  assert.deepEqual(Array.from(updates[0].payload?.freeTargets ?? []), ['chatgpt', 'claude', 'gemini', 'grok']);
});

test('absent meta permission does nothing when Meta is already standby', async (t) => {
  const app = worker({
    standbyProvider: 'meta',
    freeTargets: ['chatgpt', 'claude', 'gemini', 'grok'],
  }, true, {}, [], { metaHostPermitted: false });
  t.after(app.close);
  await app.ready;
  app.runtime.onStartup.listeners[0]();
  app.runtime.onInstalled.listeners[0]();
  await flushWorkerTurns();
  assert.equal(app.local.standbyProvider, 'meta');
  assert.deepEqual(app.local.freeTargets, ['chatgpt', 'claude', 'gemini', 'grok']);
  assert.equal(selectionUpdates(app).length, 0);
  assert.equal(app.dynamicScripts.length, 0);
});

test('granted meta permission does not reset standby', async (t) => {
  const app = worker({
    standbyProvider: 'grok',
    freeTargets: ['chatgpt', 'claude', 'gemini', 'meta'],
  });
  t.after(app.close);
  await app.ready;
  assert.equal(app.dynamicScripts.some((script) => script.id === META_CONTENT_SCRIPT_ID), true);
  app.runtime.onStartup.listeners[0]();
  app.runtime.onInstalled.listeners[0]();
  app.permissions.onRemoved.listeners[0]({ origins: [...META_ORIGINS] });
  await flushWorkerTurns();
  assert.equal(app.local.standbyProvider, 'grok');
  assert.deepEqual(app.local.freeTargets, ['chatgpt', 'claude', 'gemini', 'meta']);
  assert.equal(selectionUpdates(app).length, 0);
  assert.equal(app.dynamicScripts.some((script) => script.id === META_CONTENT_SCRIPT_ID), true);
});

test('a standby reset blocked by an active workflow is retried by the next reconcile', async (t) => {
  const app = worker({
    standbyProvider: 'grok',
    freeTargets: ['chatgpt', 'claude', 'gemini', 'meta'],
  }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('free', ['meta']);
  await waitUntil(() => app.sent.length === 1, 'workflow holds the standby seat');
  app.grantMetaHostAccess(false);
  app.runtime.onStartup.listeners[0]();
  await flushWorkerTurns();
  assert.equal(app.local.standbyProvider, 'grok');
  assert.deepEqual(app.local.freeTargets, ['chatgpt', 'claude', 'gemini', 'meta']);
  assert.equal(selectionUpdates(app).length, 0);
  assert.equal(app.dynamicScripts.some((script) => script.id === META_CONTENT_SCRIPT_ID), false);
  app.complete(app.sent[0]);
  await running;
  assert.equal(app.local.standbyProvider, 'grok');
  app.runtime.onInstalled.listeners[0]();
  await waitUntil(() => app.local.standbyProvider === 'meta', 'reconcile retries after the workflow');
  assert.deepEqual(Array.from(app.local.freeTargets as string[]), ['chatgpt', 'claude', 'gemini', 'grok']);
  const updates = selectionUpdates(app);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload?.standbyProvider, 'meta');
  assert.deepEqual(Array.from(updates[0].payload?.freeTargets ?? []), ['chatgpt', 'claude', 'gemini', 'grok']);
});

test('GET_CONNECTIONS for a different session does not rebind a live Meta debate', async (t) => {
  const app = worker({ standbyProvider: 'grok' }, false);
  t.after(app.close);
  await app.ready;
  const running = app.send('debate', undefined, { roles: META_DEBATE });
  await waitUntil(() => app.sent.length === 1, 'Meta debate before other session');
  await app.command({ action: 'GET_CONNECTIONS', payload: { clientId: 'other-panel', sessionId: 'other-session' } });
  assert.equal((await app.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId: app.sent[0].workflowId, sessionId: 'session', clientId: 'other-panel' },
  })).ok, false);
  assert.equal((await app.command({
    action: 'CANCEL_WORKFLOW',
    payload: { workflowId: app.sent[0].workflowId, sessionId: 'session', clientId: 'client' },
  })).ok, true);
  await running;
});
