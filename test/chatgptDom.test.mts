import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHATGPT_INPUT_SELECTORS,
  isChatGptComposerInput,
  isChatGptSendControl,
  isChatGptStopControl,
  isIncompleteChatGptAssistantTurn,
} from '../src/content/chatgptDom.ts';
import { firstAcceptedCandidate } from '../src/content/elementSelection.ts';

interface FakeElement {
  id: string;
  visible: boolean;
  inExplicitComposer: boolean;
  inCurrentComposerForm: boolean;
  inForm: boolean;
  formHasComposerControl: boolean;
  formHasGenericSend: boolean;
  testId: string | null;
  attributes: Record<string, string>;
  closest(selectors: string): unknown;
  getAttribute(name: string): string | null;
}

function fakeElement(options: Partial<FakeElement> = {}): FakeElement {
  const element: FakeElement = {
    id: '',
    visible: true,
    inExplicitComposer: false,
    inCurrentComposerForm: false,
    inForm: false,
    formHasComposerControl: false,
    formHasGenericSend: false,
    testId: null,
    attributes: {},
    closest: (selectors) => {
      if (selectors.includes('form[data-chatgpt-composer]') && element.inCurrentComposerForm) return {};
      if (selectors.includes('[data-testid*="composer"]')) {
        return element.inExplicitComposer ? {} : null;
      }
      if (selectors === 'form' && element.inForm) {
        return {
          querySelector: (query: string) => element.formHasComposerControl
            || (element.formHasGenericSend && query.includes('aria-label="Send"'))
            ? {}
            : null,
        };
      }
      return null;
    },
    getAttribute: (name) => name === 'data-testid' ? element.testId : element.attributes[name] ?? null,
  };
  return Object.assign(element, options);
}

test('ChatGPT input lookup skips a hidden legacy prompt and an unrelated ProseMirror', () => {
  const hiddenPrompt = fakeElement({ id: 'prompt-textarea', visible: false });
  const editFormEditor = fakeElement({ inForm: true, formHasGenericSend: true });
  const composerEditor = fakeElement({ inForm: true, formHasComposerControl: true });
  const candidates = new Map<string, readonly FakeElement[]>([
    ['#prompt-textarea', [hiddenPrompt]],
    ['.ProseMirror[contenteditable="true"]', [editFormEditor, composerEditor]],
  ]);

  const selected = firstAcceptedCandidate(
    CHATGPT_INPUT_SELECTORS,
    (selector) => candidates.get(selector) ?? [],
    (candidate) => candidate.visible && isChatGptComposerInput(candidate),
  );

  assert.strictEqual(selected, composerEditor);
  assert.equal(isChatGptComposerInput(editFormEditor), false);
});

test('the current ChatGPT composer form admits its editor but a marker-only editor stays unrecognized', () => {
  assert.equal(isChatGptComposerInput(fakeElement({
    inCurrentComposerForm: true,
    attributes: { 'data-composer-markdown': '', role: 'textbox' },
  })), true);
  assert.equal(isChatGptComposerInput(fakeElement({
    attributes: { 'data-composer-markdown': '', role: 'textbox' },
  })), false);
  assert.equal(isChatGptComposerInput(fakeElement({
    attributes: { role: 'textbox' },
  })), false);
});

test('generic visible Stop controls outside the composer are ignored', () => {
  assert.equal(isChatGptStopControl(fakeElement()), false);
  assert.equal(isChatGptStopControl(fakeElement({ inExplicitComposer: true })), true);
  assert.equal(isChatGptStopControl(fakeElement({ testId: 'composer-stop-button' })), true);
});

test('generic Send controls outside the composer are ignored', () => {
  assert.equal(isChatGptSendControl(fakeElement()), false);
  assert.equal(isChatGptSendControl(fakeElement({ inExplicitComposer: true })), true);
  assert.equal(isChatGptSendControl(fakeElement({ testId: 'send-button' })), true);
});

test('an unanswered user turn is not mistaken for active assistant generation', () => {
  const turn = (role: 'user' | 'assistant', complete: boolean) => ({
    matches: () => false,
    querySelector: (selector: string) => {
      if (selector === '[data-message-author-role="assistant"]') return role === 'assistant' ? {} : null;
      if (selector === '[data-testid="copy-turn-action-button"]') return complete ? {} : null;
      return null;
    },
  });
  assert.equal(isIncompleteChatGptAssistantTurn(turn('user', false)), false);
  assert.equal(isIncompleteChatGptAssistantTurn(turn('assistant', false)), true);
  assert.equal(isIncompleteChatGptAssistantTurn(turn('assistant', true)), false);
});
