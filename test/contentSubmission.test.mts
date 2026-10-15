import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';

function content(t: TestContext, options: {
  strict?: boolean;
  single?: boolean;
  preserveExistingDraft?: boolean;
  readInputText?: (editor: any) => string;
  inputMatchesPrompt?: (editor: any, text: string) => boolean;
  initialThinking?: boolean;
  draft?: string;
  inputAvailable?: boolean;
  sendAvailable?: boolean;
  disabled?: boolean;
  clearOnClick?: boolean;
  deferFirstInjection?: boolean;
  useGrokAdapter?: boolean;
} = {}) {
  let now = 10000;
  let timerId = 0;
  const pending = new Map<number, { callback: () => void; at: number; interval?: number }>();
  const schedule = (callback: () => void, delay: number, repeat = false) => {
    const id = ++timerId;
    pending.set(id, { callback, at: now + delay, interval: repeat ? delay : undefined });
    return id;
  };
  const timers = {
    setTimeout: (callback: () => void, delay: number) => schedule(callback, delay),
    setInterval: (callback: () => void, delay: number) => schedule(callback, delay, true),
    clearTimeout: (id: number) => { pending.delete(id); },
    clearInterval: (id: number) => { pending.delete(id); },
  };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  async function advance(ms: number) {
    const until = now + ms;
    while (true) {
      await flush();
      const next = [...pending].filter(([, timer]) => timer.at <= until)
        .sort(([idA, a], [idB, b]) => a.at - b.at || idA - idB)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.interval !== undefined) timer.at += timer.interval;
      else pending.delete(id);
      timer.callback();
    }
    now = until;
    await flush();
  }
  let listener: Function;
  let mutation: Function;
  let clicks = 0;
  let enters = 0;
  let injections = 0;
  let stopAvailable = false;
  let stopClicks = 0;
  let inputAvailable = options.inputAvailable ?? true;
  let thinking = options.initialThinking ?? false;
  let sendAvailable = options.sendAvailable ?? true;
  let releaseInjection: (() => void) | undefined;
  const injectionGuards: (() => boolean)[] = [];
  const messages: any[] = [];
  class Element {
    textContent = '';
    nodeType = 1;
    tagName = 'DIV';
    disabled = false;
    isConnected = true;
    focus() { document.activeElement = this; }
    closest() { return null; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    getClientRects() { return [{}]; }
    dispatchEvent(event: { type: string }) { if (event.type === 'keydown') enters++; return true; }
    compareDocumentPosition() { return 4; }
  }
  class Textarea extends Element { value = ''; }
  let input = Object.assign(new Textarea(), { value: options.draft ?? '' });
  const send = Object.assign(new Element(), {
    disabled: options.disabled ?? false,
    click() { clicks++; if (options.clearOnClick) input.value = ''; },
  });
  const stop = Object.assign(new Element(), { click() { stopClicks++; stopAvailable = false; } });
  const users: Element[] = [];
  const responses: Element[] = [];
  const document = {
    body: {}, activeElement: input as Element,
    querySelectorAll(selector: string) {
      if (selector === '#input') return inputAvailable ? [input] : [];
      if (selector === '#send') return sendAvailable ? [send] : [];
      if (selector === '#stop') return stopAvailable ? [stop] : [];
      if (selector === '#user') return users;
      if (selector === '#answer') return responses;
      return [];
    },
  };
  const window = { ...timers, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } as any;
  const context = vm.createContext({
    window, document, ...timers, Date: class extends Date { static now() { return now; } },
    HTMLElement: Element, HTMLTextAreaElement: Textarea, HTMLInputElement: class extends Element {},
    KeyboardEvent: class { type: string; constructor(type: string) { this.type = type; } },
    MutationObserver: class {
      constructor(callback: Function) { mutation = callback; }
      observe() {} disconnect() {}
    },
    chrome: { runtime: {
      id: 'test', sendMessage: async (message: any) => { messages.push(message); },
      onMessage: { addListener(callback: Function) { listener = callback; }, removeListener() {} },
    } },
  });
  const cache = new Map<string, any>();
  let captureAdapter = false;
  let adapterConfig: any;
  function load(file: string): any {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInContext(`(function(require, module, exports) {${code}\n})`, context)(
      (relative: string) => captureAdapter && relative === './base'
        ? { createContentScript: (config: any) => { adapterConfig = config; } }
        : load(path.resolve(path.dirname(file), `${relative}.ts`)), module, module.exports,
    );
    return module.exports;
  }
  if (options.useGrokAdapter) {
    captureAdapter = true;
    load(fileURLToPath(new URL('../src/content/grok.ts', import.meta.url)));
    captureAdapter = false;
  }
  load(fileURLToPath(new URL('../src/content/base.ts', import.meta.url))).createContentScript({
    ...adapterConfig,
    provider: 'grok', inputSelectors: ['#input'], sendButtonSelectors: ['#send'],
    userMessageSelectors: ['#user'], userMessageTracking: 'semantic-count',
    sendConfirmation: options.useGrokAdapter ? adapterConfig.sendConfirmation
      : options.single ? 'single-activation' : options.strict === false ? 'heuristic' : 'matching-user-message',
    preserveExistingDraft: options.preserveExistingDraft,
    readInputText: options.readInputText,
    inputMatchesPrompt: options.inputMatchesPrompt,
    requireSameComposerForClearConfirmation: true,
    responseSelectors: ['#answer'], responseTracking: 'semantic-latest',
    stopButtonSelectors: ['#stop'], stopButtonFilter: () => true,
    requireMatchingUserMessageForGenerationSignals: !options.single,
    anchorSemanticResponsesAfterMatchingUserMessage: !options.single,
    inputFilter: () => true, sendButtonFilter: () => true, isThinking: () => thinking,
    loginDetector: () => true,
    injectInput: (editor: Textarea, text: string, isActive?: () => boolean) => {
      if (isActive) injectionGuards.push(isActive);
      injections++; editor.value = text;
      if (options.deferFirstInjection && injections === 1) {
        return new Promise<void>(resolve => { releaseInjection = resolve; });
      }
    },
    doneDelay: 1000, chunkDebounce: 0,
  });
  t.after(() => window.__multiAiChat_grok.dispose());
  const command = (message: any): Promise<any> => new Promise(resolve => listener(message, {}, resolve));
  return {
    advance, flush,
    send: (requestId = 'request', text = 'prompt') => command({
      action: 'SEND_MESSAGE', provider: 'grok', requestId, workflowId: 'workflow', payload: { text },
    }),
    stop: (requestId = 'request') => command({
      action: 'STOP_GENERATION', provider: 'grok', requestId, workflowId: 'workflow',
    }),
    queryRequest: (requestId = 'request') => command({
      action: 'QUERY_PROVIDER_REQUEST_STATE', provider: 'grok', requestId, workflowId: 'workflow',
    }),
    inputReady() { inputAvailable = true; },
    thinking(value: boolean) { thinking = value; },
    replaceComposer(draft = '') { input.isConnected = false; input = Object.assign(new Textarea(), { value: draft }); },
    clearComposer() { input.value = ''; },
    releaseInjection() { releaseInjection?.(); },
    injectionIsActive: (index: number) => injectionGuards[index]?.(),
    showStop() { stopAvailable = true; },
    stopClicks: () => stopClicks,
    accepted(text = 'prompt') { users.push(Object.assign(new Element(), { textContent: text })); mutation(); },
    answer(text: string) { responses.push(Object.assign(new Element(), { textContent: text })); mutation(); },
    remountAnswers() {
      const texts = responses.map((response) => response.textContent);
      responses.splice(0, responses.length, ...texts.map((textContent) => Object.assign(new Element(), { textContent })));
      mutation();
    },
    counts: () => ({ clicks, enters, injections }),
    draft: () => input.value,
    done: () => messages.filter(message => message.action === 'RESPONSE_DONE'),
    chunks: () => messages.filter(message => message.action === 'RESPONSE_CHUNK'),
  };
}

test('single activation preserves an unrelated existing draft and significant quoted whitespace', async t => {
  const app = content(t, { single: true, preserveExistingDraft: true, draft: 'Use "a b"' });
  assert.equal((await app.send('request', 'Use "ab"')).ok, false);
  await app.advance(15000);
  assert.equal(app.draft(), 'Use "a b"');
  assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 0 });
  assert.match(app.done()[0]?.payload, /error.existing_draft/);
});

test('configured composer reader is used for initial, prepared and verified prompt text', async t => {
  const app = content(t, {
    single: true, preserveExistingDraft: true, draft: 'first\u2028second',
    readInputText: (editor) => editor.value.replace(/\u2028/g, '\n'),
  });
  assert.equal((await app.send('request', 'first\nsecond')).ok, true);
  await app.advance(800);
  app.accepted('first\nsecond'); app.answer('answer');
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 0 });
  assert.equal(app.done()[0]?.payload, 'answer');
});

test('configured composer matcher permits only its exact editor representation throughout submission', async t => {
  const app = content(t, {
    single: true, preserveExistingDraft: true, draft: 'prompt\n',
    inputMatchesPrompt: (editor, text) => editor.value.replace(/\n$/, '') === text,
  });
  assert.equal((await app.send()).ok, true);
  await app.advance(800);
  app.accepted(); app.answer('answer');
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 0 });
  assert.equal(app.done()[0]?.payload, 'answer');
});

test('single activation reports uncertainty after one click without Enter or automatic refill', async t => {
  const app = content(t, { single: true, preserveExistingDraft: true });
  assert.equal((await app.send()).ok, true);
  await app.advance(800);
  app.replaceComposer();
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.equal(app.draft(), '');
  assert.match(app.done()[0]?.payload, /error.send_unconfirmed/);
});

test('a settled dispatched failure retains uncertain ownership for a restarted worker', async t => {
  const app = content(t, { single: true, preserveExistingDraft: true });
  await app.send();
  await app.advance(15000);
  const snapshot = await app.queryRequest();
  assert.equal(snapshot.state, 'uncertain_submission');
  assert.equal(snapshot.submission, 'uncertain');
});

for (const remount of [false, true]) {
  test(`single mode rejects a verified composer that ${remount ? 'remounts empty' : 'rolls back empty'} before Send without another insertion`, async t => {
    const app = content(t, { single: true, preserveExistingDraft: true });
    assert.equal((await app.send()).ok, true);
    if (remount) app.replaceComposer();
    else app.clearComposer();
    await app.advance(15000);
    assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 1 });
    assert.equal(app.draft(), '');
    assert.match(app.done()[0]?.payload, /error.input_injection_failed|error.send_unconfirmed/);
  });
}

test('cleared single-activation composer alone cannot confirm provider acceptance', async t => {
  const app = content(t, { single: true, clearOnClick: true });
  await app.send(); await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.match(app.done()[0]?.payload, /error.send_unconfirmed/);
});

test('single activation accepts a new response without repeating the send', async t => {
  const app = content(t, { single: true });
  await app.send(); await app.advance(5000);
  app.answer('current response');
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.equal(app.done()[0]?.payload, 'current response');
});

test('a configured composer reader rejects changed provider text before any Send activation', async t => {
  const app = content(t, {
    single: true,
    readInputText: (editor) => editor.value ? 'provider changed the prompt' : '',
  });
  const acknowledgement = await app.send();
  assert.equal(acknowledgement.ok, false);
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 1 });
  assert.match(app.done()[0]?.payload, /error.input_injection_failed/);
  assert.equal(acknowledgement.failureAlreadyReported, true);
});

test('single activation refuses an already-generating provider before touching its composer', async t => {
  const app = content(t, { single: true, initialThinking: true });
  const acknowledgement = await app.send();
  assert.equal(acknowledgement.ok, false);
  assert.match(acknowledgement.error, /error.response_in_progress/);
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 0 });
  assert.equal(app.done().length, 0);
});

test('single activation refuses a provider that starts generating before the scheduled Send', async t => {
  const app = content(t, { single: true });
  await app.send();
  app.thinking(true);
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 1 });
  assert.match(app.done()[0]?.payload, /error.response_in_progress/);
});

test('cancelling a single-mode request that never dispatched cannot stop the old provider stream', async t => {
  const app = content(t, { single: true });
  await app.send();
  app.thinking(true); app.showStop();
  await app.advance(800);
  assert.equal(app.counts().clicks, 0);
  assert.match(app.done()[0]?.payload, /error.response_in_progress/);
  assert.equal((await app.stop()).ok, true);
  assert.equal(app.stopClicks(), 0);
});

test('a cancelled dispatched single-mode request stops its own stream when Stop appears late', async t => {
  const app = content(t, { single: true });
  await app.send(); await app.advance(800);
  assert.equal((await app.stop()).ok, true);
  app.showStop(); await app.advance(500);
  assert.equal(app.stopClicks(), 1);
  app.answer('late cancelled response'); await app.advance(15000);
  assert.equal(app.done().length, 0);
  assert.equal(app.chunks().length, 0);
});

for (const nextId of ['new-request', 'request']) {
  test(`cancelled single-mode cleanup cannot stop a newer generation with request id ${nextId}`, async t => {
    const app = content(t, { single: true });
    await app.send(); await app.advance(800); await app.stop();
    await app.send(nextId, 'new prompt');
    app.showStop(); await app.advance(500);
    assert.equal(app.stopClicks(), 0);
    assert.equal(app.draft(), 'new prompt');
  });
}

test('single-mode late Stop cleanup is bounded while an exact later scoped Stop remains available', async t => {
  const app = content(t, { single: true });
  await app.send(); await app.advance(800); await app.stop();
  await app.advance(11000);
  app.showStop(); await app.advance(500);
  assert.equal(app.stopClicks(), 0);
  assert.equal((await app.stop()).ok, true);
  assert.equal(app.stopClicks(), 1);
});

test('single activation excludes orphan user and response evidence that arrives before its Send', async t => {
  const app = content(t, { single: true });
  await app.send();
  app.accepted(); app.answer('orphan before Send');
  await app.advance(700);
  assert.equal(app.done().length, 0);
  assert.equal(app.chunks().length, 0);
  assert.equal(app.counts().clicks, 0);
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.equal(app.done().length, 1);
  assert.match(app.done()[0]?.payload, /error.send_unconfirmed/);
  assert.equal(app.chunks().length, 0);
});

test('an orphan response during awaited single-mode insertion cannot finish or replace the dispatched response', async t => {
  const app = content(t, { single: true, deferFirstInjection: true });
  const sending = app.send(); await app.flush();
  app.answer('orphan during injection');
  await app.advance(5000);
  assert.equal(app.done().length, 0);
  assert.equal(app.chunks().length, 0);
  app.releaseInjection();
  assert.equal((await sending).ok, true);
  await app.advance(0);
  assert.equal(app.counts().clicks, 1);
  app.answer('response after actual Send');
  await app.advance(15000);
  assert.equal(app.done().length, 1);
  assert.equal(app.done()[0]?.payload, 'response after actual Send');
  assert.equal(app.chunks().some((message) => message.payload === 'orphan during injection'), false);
});

test('semantic single-mode tracking ignores a remount of the same old response after Send', async t => {
  const app = content(t, { single: true });
  app.answer('old response');
  await app.send(); await app.advance(800);
  app.remountAnswers();
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.equal(app.chunks().length, 0);
  assert.match(app.done()[0]?.payload, /error.send_unconfirmed/);
});

test('a new generation signal after single activation confirms acceptance without replay', async t => {
  const app = content(t, { single: true });
  await app.send(); await app.advance(800);
  app.thinking(true);
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.equal(app.done().length, 0);
});

for (const options of [{ disabled: true }, { sendAvailable: false }]) {
  test(`single activation does not fall back to Enter for ${options.disabled ? 'disabled' : 'missing'} Send`, async t => {
    const app = content(t, { single: true, ...options });
    await app.send(); await app.advance(15000);
    assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 1 });
    assert.match(app.done()[0]?.payload, options.disabled ? /error.send_action_disabled/ : /error.send_action_unavailable/);
  });
}

test('injection guard captures the request generation across an awaited cancellation and reused id', async t => {
  const app = content(t, { single: true, deferFirstInjection: true });
  const old = app.send('same-id', 'old prompt'); await app.flush();
  assert.equal(app.injectionIsActive(0), true);
  await app.stop('same-id');
  await app.send('same-id', 'new prompt');
  assert.equal(app.injectionIsActive(0), false);
  assert.equal(app.injectionIsActive(1), true);
  app.releaseInjection(); await app.flush();
  assert.equal((await old).ok, false);
  assert.equal(app.done().length, 0);
  assert.equal(app.draft(), 'new prompt');
});

test('Grok preserves a different existing draft without activating submission', async t => {
  const app = content(t, { draft: 'my unfinished draft' });
  assert.equal((await app.send()).ok, false);
  await app.advance(15000);
  assert.equal(app.draft(), 'my unfinished draft');
  assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 0 });
  assert.match(app.done()[0]?.payload, /error.existing_draft/);
});

test('Grok preserves significant whitespace in a different existing draft', async t => {
  const app = content(t, { draft: 'Use "a b"' });
  assert.equal((await app.send('request', 'Use "ab"')).ok, false);
  await app.advance(15000);
  assert.equal(app.draft(), 'Use "a b"');
  assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 0 });
  assert.match(app.done()[0]?.payload, /error.existing_draft/);
});

test('Grok attempts one activation and reports uncertainty while preserving its draft', async t => {
  const app = content(t);
  assert.equal((await app.send()).ok, true);
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.equal(app.draft(), 'prompt');
  assert.equal(app.done().length, 1);
  assert.match(app.done()[0].payload, /error.send_unconfirmed/);
});

test('the actual Grok adapter opts into confirmed single-activation submission', async t => {
  const app = content(t, { useGrokAdapter: true });
  await app.send(); await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.match(app.done()[0]?.payload, /error.send_unconfirmed/);
});

test('clearing the same Grok composer cannot confirm acceptance', async t => {
  const app = content(t, { clearOnClick: true });
  await app.send();
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.match(app.done()[0]?.payload, /error.send_unconfirmed/);
});

test('an empty replacement after Grok activation is not reinjected or replayed', async t => {
  const app = content(t);
  await app.send(); await app.advance(800);
  app.replaceComposer();
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.equal(app.draft(), '');
  assert.match(app.done()[0]?.payload, /error.send_unconfirmed/);
});

test('Grok accepts a late matching user turn without replaying submission', async t => {
  const app = content(t);
  await app.send(); await app.advance(5000);
  app.accepted(); app.answer('complete answer');
  await app.advance(15000);
  assert.deepEqual(app.counts(), { clicks: 1, enters: 0, injections: 1 });
  assert.equal(app.done().length, 1);
  assert.equal(app.done()[0].payload, 'complete answer');
});

for (const state of ['disabled', 'unavailable'] as const) {
  test(`Grok ${state} send control does not fall through to Enter`, async t => {
    const app = content(t, { disabled: state === 'disabled', sendAvailable: state !== 'unavailable' });
    await app.send(); await app.advance(15000);
    assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 1 });
    assert.equal(app.draft(), 'prompt');
    assert.match(app.done()[0]?.payload, new RegExp(`error.send_action_${state}`));
  });
}

test('scoped cancellation during initial lookup prevents later injection and completion', async t => {
  const app = content(t, { inputAvailable: false });
  const pending = app.send(); await app.flush();
  assert.equal((await app.stop()).ok, true);
  app.inputReady(); await app.advance(15000);
  assert.equal((await pending).ok, false);
  assert.deepEqual(app.counts(), { clicks: 0, enters: 0, injections: 0 });
  assert.equal(app.done().length, 0);
});

for (const newId of ['new', 'old']) {
  test(`an obsolete injection cannot settle a newer generation with request ID ${newId}`, async t => {
    const app = content(t, { strict: false, deferFirstInjection: true });
    const old = app.send('old', 'old prompt'); await app.flush();
    assert.equal((await app.stop('old')).ok, true);
    assert.equal((await app.send(newId, 'new prompt')).ok, true);
    app.releaseInjection(); await app.flush();
    assert.equal((await old).ok, false);
    assert.equal(app.done().length, 0);
    assert.equal((await app.stop(newId)).ok, true);
  });
}

test('concurrent SEND rejects the second request before injection', async t => {
  const app = content(t, { strict: false });
  const [first, second] = await Promise.all([app.send('first'), app.send('second', 'other prompt')]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.error, /error.response_in_progress/);
  assert.equal(app.counts().injections, 1);
  assert.equal(app.done().length, 0);
});

test('cancelled Grok submission can stop a stream that starts after cancellation', async t => {
  const app = content(t);
  await app.send(); await app.advance(800);
  assert.equal((await app.stop()).ok, true);
  app.showStop();
  assert.equal((await app.stop()).ok, true);
  assert.equal(app.stopClicks(), 1);
  app.accepted(); app.answer('late cancelled response');
  await app.advance(15000);
  assert.equal(app.done().length, 0);
});

test('cancelled Grok submission performs bounded cleanup when its Stop control appears late', async t => {
  const app = content(t);
  await app.send(); await app.advance(800); await app.stop();
  app.showStop(); await app.advance(500);
  assert.equal(app.stopClicks(), 1);
  assert.equal(app.done().length, 0);
});

for (const newId of ['new', 'request']) {
  test(`cancelled Grok cleanup cannot stop a newer generation with request ID ${newId}`, async t => {
    const app = content(t);
    await app.send(); await app.advance(800); await app.stop();
    await app.send(newId); await app.advance(800);
    app.showStop(); await app.advance(500);
    assert.equal(app.stopClicks(), 0);
    assert.equal((await app.stop(newId)).ok, true);
    assert.equal(app.stopClicks(), 1);
  });
}

test('cancelled Grok cleanup stops polling at its bound while retaining exact scoped Stop', async t => {
  const app = content(t);
  await app.send(); await app.advance(800); await app.stop();
  await app.advance(15000);
  app.showStop(); await app.advance(1000);
  assert.equal(app.stopClicks(), 0);
  assert.equal((await app.stop()).ok, true);
  assert.equal(app.stopClicks(), 1);
});

test('unconfirmed Grok failure retains an exact scoped Stop for an orphan stream', async t => {
  const app = content(t);
  await app.send(); await app.advance(15000);
  assert.match(app.done()[0]?.payload, /error.send_unconfirmed/);
  app.showStop();
  assert.equal((await app.stop()).ok, true);
  assert.equal(app.stopClicks(), 1);
});
