import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { captureSemanticResponseBaseline, currentSemanticResponseText } from '../src/content/responseTracking.ts';
import { extractResponseContent } from '../src/content/responseSerializer.ts';

// Run the real Gemini adapter against a controlled editor that reconciles on a
// later task. textContent intentionally concatenates Quill paragraph children.
function inputHarness() {
  const events: any[] = [];
  const commands: Array<{ command: string; showUi: boolean; text: string }> = [];
  const selected: unknown[] = [];
  let activeElement: Editor | null = null;
  let selectedEditor: Editor | null = null;
  let selectionAvailable = true;
  let redirectedSelection: Editor | null = null;
  let onExecCommand: (command: string, showUi: boolean, text: string) => boolean = () => false;
  let config: any;
  class Editor {
    nodeType = 1;
    tagName = 'DIV';
    childNodes: any[] = [];
    isConnected = true;
    isContentEditable = true;
    disabled = false;
    readOnly = false;
    visible = true;
    inRichTextarea = true;
    qlEditor = true;
    onEvent: (event: any) => void = () => {};
    get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
    get innerText() { return this.childNodes.map(child => readInline(child)).join('\n'); }
    focus() { activeElement = this; }
    contains(node: unknown) { return node === this; }
    getClientRects() { return this.visible ? [{}] : []; }
    getAttribute(name: string) { return name === 'contenteditable' ? 'true' : null; }
    matches(selector: string) { return selector.includes('.ql-editor') && this.qlEditor; }
    closest(selector: string) {
      if (selector.includes('rich-textarea')) return this.inRichTextarea ? {} : null;
      return null;
    }
    dispatchEvent(event: any) { events.push(event); this.onEvent(event); return !event.defaultPrevented; }
    replaceChildren() { throw new Error('must not replace editor-owned DOM'); }
    appendChild() { throw new Error('must not append editor-owned DOM'); }
    commit(text: string) { this.childNodes = text.split('\n').map(paragraph); }
  }
  class Transfer {
    data = new Map<string, string>();
    setData(type: string, value: string) { this.data.set(type, value); }
    getData(type: string) { return this.data.get(type) ?? ''; }
  }
  class ClipboardEvent extends Event {
    clipboardData: Transfer;
    constructor(type: string, options: any) { super(type, options); this.clipboardData = options.clipboardData; }
  }
  const selection = {
    removeAllRanges() { selectedEditor = null; },
    addRange(range: { commonAncestorContainer: unknown }) {
      selectedEditor = redirectedSelection ?? range.commonAncestorContainer as Editor;
    },
    get rangeCount() { return selectedEditor ? 1 : 0; },
    getRangeAt(index: number) {
      if (index !== 0 || !selectedEditor) throw new Error('selection unavailable');
      return { commonAncestorContainer: selectedEditor };
    },
  };
  const context = vm.createContext({
    HTMLElement: Editor, HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    DataTransfer: Transfer, ClipboardEvent, Event, setTimeout,
    window: {
      getComputedStyle: (element: Editor) => ({ display: element.visible ? 'block' : 'none', visibility: 'visible', opacity: '1' }),
      getSelection: () => selectionAvailable ? selection : null,
    },
    document: {
      get activeElement() { return activeElement; },
      createRange: () => {
        let selectedNode: unknown;
        return {
          selectNodeContents: (editor: unknown) => { selected.push(editor); selectedNode = editor; },
          get commonAncestorContainer() { return selectedNode; },
        };
      },
      execCommand(command: string, showUi: boolean, text: string) {
        commands.push({ command, showUi, text });
        return onExecCommand(command, showUi, text);
      },
    },
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
      (relative: string) => relative === './base'
        ? { createContentScript: (value: any) => { config = value; } }
        : load(path.resolve(path.dirname(file), `${relative}.ts`)), module, module.exports,
    );
    return module.exports;
  }
  load(fileURLToPath(new URL('../src/content/gemini.ts', import.meta.url)));
  return {
    config, Editor, events, commands, selected,
    selectionTarget: () => selectedEditor,
    setExecCommand: (handler: (command: string, showUi: boolean, text: string) => boolean) => { onExecCommand = handler; },
    setActiveElement: (element: Editor | null) => { activeElement = element; },
    setSelectionAvailable: (available: boolean) => { selectionAvailable = available; },
    redirectSelectionTo: (element: Editor | null) => { redirectedSelection = element; },
  };
}

test('Gemini performs one native insertText and verifies exact editor text', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  const text = 'First line\n\nUse "a  b" + 2\nمرحبا 👩‍💻\n中文 ✓';
  app.setExecCommand((command, showUi, insertedText) => {
    assert.equal(command, 'insertText');
    assert.equal(showUi, false);
    assert.equal(insertedText, text);
    assert.equal(app.selectionTarget(), editor);
    setTimeout(() => editor.commit(insertedText), 0);
    return true;
  });
  await app.config.injectInput(editor, text);
  assert.equal(editor.textContent.includes('\n'), false);
  assert.equal(app.config.readInputText(editor), text);
  assert.equal(app.config.inputMatchesPrompt(editor, text), true);
  assert.deepEqual(app.commands, [{ command: 'insertText', showUi: false, text }]);
  assert.deepEqual(app.events, []);
  assert.deepEqual(app.selected, [editor]);
});

test('Gemini accepts a false native-command return when exact editor readback arrives', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  const text = 'Delayed\n\nمرحبا 👩‍💻';
  app.setExecCommand((command, showUi, insertedText) => {
    assert.equal(command, 'insertText');
    assert.equal(showUi, false);
    setTimeout(() => editor.commit(insertedText), 40);
    return false;
  });
  await app.config.injectInput(editor, text);
  assert.equal(app.config.readInputText(editor), text);
  assert.deepEqual(app.commands, [{ command: 'insertText', showUi: false, text }]);
  assert.deepEqual(app.events, []);
});

test('Gemini keeps waiting for an exact controlled-editor commit beyond one background timer quantum', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  const text = 'Delayed background reconciliation\n\nKeep exact whitespace.';
  app.setExecCommand((_command, _showUi, insertedText) => {
    setTimeout(() => editor.commit(insertedText), 1200);
    return true;
  });
  await app.config.injectInput(editor, text);
  assert.equal(app.config.readInputText(editor), text);
  assert.equal(app.commands.length, 1);
  assert.deepEqual(app.events, []);
});

test('Gemini cancellation during native insertion settlement stops verification without replay', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  let active = true;
  app.setExecCommand((_command, _showUi, insertedText) => {
    setTimeout(() => { active = false; }, 15);
    setTimeout(() => editor.commit(insertedText), 100);
    return true;
  });
  await assert.rejects(() => app.config.injectInput(editor, 'old prompt', () => active), /request cancelled/);
  assert.equal(app.commands.length, 1);
  assert.deepEqual(app.events, []);
});

test('Gemini stops verification when its editor disconnects during native insertion settlement', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  app.setExecCommand((_command, _showUi, insertedText) => {
    setTimeout(() => { editor.isConnected = false; }, 15);
    setTimeout(() => editor.commit(insertedText), 100);
    return true;
  });
  await assert.rejects(() => app.config.injectInput(editor, 'old prompt'), /editor disconnected/);
  assert.equal(app.commands.length, 1);
  assert.deepEqual(app.events, []);
});

test('Gemini rejects an uncommitted native insert without paste or replay fallback', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  app.setExecCommand(() => false);
  await assert.rejects(() => app.config.injectInput(editor, 'requested prompt'), /editor text did not match the requested prompt/);
  assert.equal(editor.textContent, '');
  assert.equal(app.commands.length, 1);
  assert.deepEqual(app.events, []);
});

test('Gemini reports a thrown native insert without direct DOM or replay fallback', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  app.setExecCommand(() => { throw new Error('native command rejected'); });
  await assert.rejects(() => app.config.injectInput(editor, 'requested prompt'), /native text insertion failed/);
  assert.equal(editor.textContent, '');
  assert.equal(app.commands.length, 1);
  assert.deepEqual(app.events, []);
});

test('Gemini preserves an unrelated existing draft including significant quoted spaces', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  editor.commit('Use "a b"');
  await assert.rejects(() => app.config.injectInput(editor, 'Use "ab"'), /different draft/);
  assert.equal(editor.textContent, 'Use "a b"');
  assert.equal(app.commands.length, 0);
  assert.equal(app.events.length, 0);
});

test('Gemini preserves whitespace-only drafts instead of overwriting them', async () => {
  for (const draft of [' ', '\t', '\n', ' \n\t']) {
    const app = inputHarness();
    const editor = new app.Editor();
    editor.commit(draft);
    await assert.rejects(() => app.config.injectInput(editor, 'requested prompt'), /different draft/);
    assert.equal(app.config.readInputText(editor), draft);
    assert.equal(app.commands.length, 0);
    assert.deepEqual(app.events, []);
  }
});

test('Gemini treats one blank-paragraph placeholder as an empty composer', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  editor.commit('');
  assert.equal(app.config.readInputText(editor), '');
  app.setExecCommand((_command, _showUi, text) => {
    editor.commit(text);
    return true;
  });
  await app.config.injectInput(editor, 'requested prompt');
  assert.equal(app.commands.length, 1);
});

test('Gemini already matching draft is verified without another native insert', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  editor.commit('existing\n\nprompt');
  await app.config.injectInput(editor, 'existing\n\nprompt');
  assert.equal(app.commands.length, 0);
  assert.equal(app.events.length, 0);
});

test('Gemini cancellation before native insert prevents an obsolete editor edit', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  let active = true;
  const injection = app.config.injectInput(editor, 'old prompt', () => active);
  active = false;
  await assert.rejects(() => injection, /request cancelled/);
  assert.equal(app.commands.length, 0);
  assert.equal(app.events.length, 0);
});

test('Gemini controlled reconciliation cannot leave an unverified visual draft ready to send', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  app.setExecCommand((_command, _showUi, insertedText) => {
    editor.commit(insertedText);
    setTimeout(() => editor.commit(''), 0);
    return true;
  });
  await assert.rejects(() => app.config.injectInput(editor, 'requested prompt'), /editor text did not match the requested prompt/);
  assert.equal(editor.textContent, '');
  assert.equal(app.commands.length, 1);
  assert.deepEqual(app.events, []);
});

test('Gemini skips a composer that becomes disabled while selection reconciles', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  const injection = app.config.injectInput(editor, 'requested prompt');
  editor.disabled = true;
  await assert.rejects(() => injection, /editor unavailable/);
  assert.equal(app.commands.length, 0);
  assert.equal(app.events.length, 0);
});

test('Gemini refuses native insertion when focus moves during editor stabilization', async () => {
  const app = inputHarness();
  const editor = new app.Editor();
  const unrelated = new app.Editor();
  const injection = app.config.injectInput(editor, 'requested prompt');
  app.setActiveElement(unrelated);
  await assert.rejects(() => injection, /editor focus moved/);
  assert.equal(app.commands.length, 0);
});

test('Gemini refuses native insertion when selection is unavailable or redirected', async () => {
  for (const setup of [
    (app: ReturnType<typeof inputHarness>, _editor: InstanceType<ReturnType<typeof inputHarness>['Editor']>) => app.setSelectionAvailable(false),
    (app: ReturnType<typeof inputHarness>, _editor: InstanceType<ReturnType<typeof inputHarness>['Editor']>) => app.redirectSelectionTo(new app.Editor()),
  ]) {
    const app = inputHarness();
    const editor = new app.Editor();
    const injection = app.config.injectInput(editor, 'requested prompt');
    setup(app, editor);
    await assert.rejects(() => injection, /editor selection (unavailable|moved)/);
    assert.equal(app.commands.length, 0);
  }
});

test('Gemini serializer preserves inline breaks, blank paragraphs, CRLF and literal whitespace', () => {
  const app = inputHarness();
  const editor = new app.Editor();
  editor.childNodes = [
    { nodeType: 1, tagName: 'P', textContent: 'firstsecond', childNodes: [
      { nodeType: 3, textContent: 'first' },
      { nodeType: 1, tagName: 'BR', textContent: '', childNodes: [] },
      { nodeType: 3, textContent: 'second' },
    ] },
    paragraph(''), paragraph('Use "a  b"\t👩‍💻'),
  ];
  const expected = 'first\nsecond\n\nUse "a  b"\t👩‍💻';
  assert.equal(app.config.readInputText(editor), expected);
  assert.equal(app.config.inputMatchesPrompt(editor, expected.replace(/\n/g, '\r\n')), true);
  assert.equal(app.config.inputMatchesPrompt(editor, expected.replace('a  b', 'a b')), false);
  assert.equal(app.config.inputMatchesPrompt(editor, expected.replace('\n\n', '\n')), false);
});

test('Gemini adapter uses visible usable composers and one activation without draft-clear confirmation', () => {
  const app = inputHarness();
  assert.equal(app.config.requireVisibleInput, true);
  assert.equal(app.config.preserveExistingDraft, true);
  assert.equal(app.config.sendConfirmation, 'single-activation');
  const unrelated = new app.Editor(); unrelated.qlEditor = false; unrelated.inRichTextarea = false;
  assert.equal(app.config.inputFilter(unrelated), false);
  const disabled = new app.Editor(); disabled.disabled = true;
  assert.equal(app.config.inputFilter(disabled), false);
  const hidden = new app.Editor(); hidden.visible = false;
  assert.equal(app.config.inputFilter(hidden), false);
  const send = new app.Editor(); send.tagName = 'BUTTON';
  assert.equal(app.config.sendButtonFilter(send), true);
  send.visible = false;
  assert.equal(app.config.sendButtonFilter(send), false);
});

test('Gemini semantic responses ignore remounted old Markdown and serialize the new answer', () => {
  const app = inputHarness();
  assert.equal(app.config.responseTracking, 'semantic-latest');
  assert.equal(app.config.responseSelectors[0], '.model-response-text .markdown');
  const previous = new app.Editor(); previous.commit('previous answer');
  const baseline = captureSemanticResponseBaseline([previous], extractResponseContent);
  const remounted = new app.Editor(); remounted.commit('previous answer');
  assert.equal(currentSemanticResponseText([remounted], baseline, extractResponseContent), null);
  const current = new app.Editor();
  current.childNodes = [paragraph('New answer ✓'), paragraph('مرحبا 👩‍💻'),
    { nodeType: 1, tagName: 'BUTTON', textContent: 'Copy', childNodes: [{ nodeType: 3, textContent: 'Copy' }] }];
  assert.equal(
    currentSemanticResponseText([remounted, current], baseline, extractResponseContent),
    'New answer ✓\n\nمرحبا 👩‍💻',
  );
});

function paragraph(text: string) {
  return { nodeType: 1, tagName: 'P', textContent: text, childNodes: text
    ? [{ nodeType: 3, textContent: text }]
    : [{ nodeType: 1, tagName: 'BR', textContent: '', childNodes: [] }] };
}

function readInline(node: any): string {
  if (node.nodeType === 3) return node.textContent;
  if (node.tagName === 'BR') return '';
  return node.childNodes.map(readInline).join('');
}
