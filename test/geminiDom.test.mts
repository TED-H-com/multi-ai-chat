import assert from 'node:assert/strict';
import test from 'node:test';
import { firstAcceptedCandidate } from '../src/content/elementSelection.ts';
import {
  GEMINI_INPUT_SELECTORS,
  GEMINI_USER_MESSAGE_SELECTORS,
  GEMINI_SEND_SELECTORS,
  isUsableGeminiComposerInput,
  isGeminiSendControl,
  isGeminiStopControl,
  readGeminiUserMessageText,
} from '../src/content/geminiDom.ts';
import { contentMatchesPrompt } from '../src/content/sendConfirmation.ts';

function control(options: {
  tagName?: string; visible?: boolean; qlEditor?: boolean; inComposer?: boolean;
  disabled?: boolean; readOnly?: boolean; disabledAncestor?: boolean;
  ariaLabel?: string; explicitSend?: boolean; formHasComposer?: boolean;
} = {}) {
  return {
    tagName: options.tagName ?? 'DIV',
    visible: options.visible ?? true,
    isContentEditable: true,
    disabled: options.disabled ?? false,
    readOnly: options.readOnly ?? false,
    getAttribute: (name: string) => name === 'contenteditable' ? 'true'
      : name === 'aria-label' ? options.ariaLabel ?? null : null,
    matches: (selector: string) => selector.includes('.ql-editor')
      ? options.qlEditor ?? false : options.explicitSend ?? false,
    closest: (selector: string) => {
      if (selector.includes('[inert]')) return options.disabledAncestor ? {} : null;
      if (selector.includes('rich-textarea')) return options.inComposer ? {} : null;
      if (selector === 'form' && options.formHasComposer) return { querySelector: () => ({}) };
      return null;
    },
  };
}

test('Gemini input lookup skips hidden, disabled and unrelated editable elements', () => {
  const hidden = control({ qlEditor: true, visible: false });
  const disabled = control({ qlEditor: true, disabled: true });
  const unrelated = control({ ariaLabel: 'Profile bio' });
  const unrelatedQuill = control({ qlEditor: true });
  const composer = control({ qlEditor: true, inComposer: true });
  const selected = firstAcceptedCandidate(
    GEMINI_INPUT_SELECTORS,
    // An unscoped Quill editor appears before the real composer in document order.
    () => [hidden, disabled, unrelated, unrelatedQuill, composer],
    element => element.visible && isUsableGeminiComposerInput(element),
  );
  assert.equal(selected, composer);
  assert.equal(GEMINI_INPUT_SELECTORS.includes('div[contenteditable="true"][aria-label]'), false);
});

test('Gemini composer lookup rejects read-only and disabled ancestor state', () => {
  assert.equal(isUsableGeminiComposerInput(control({ qlEditor: true, readOnly: true })), false);
  assert.equal(isUsableGeminiComposerInput(control({ qlEditor: true, disabledAncestor: true })), false);
  assert.equal(isUsableGeminiComposerInput(control({ ariaLabel: 'Enter a prompt here' })), true);
});

test('Gemini controls require the actual button and a known send or composer scope', () => {
  assert.equal(isGeminiSendControl(control({ tagName: 'BUTTON', explicitSend: true })), true);
  assert.equal(isGeminiSendControl(control({ tagName: 'BUTTON', inComposer: true })), true);
  assert.equal(isGeminiSendControl(control({ tagName: 'BUTTON', formHasComposer: true })), true);
  assert.equal(isGeminiSendControl(control({ tagName: 'BUTTON', ariaLabel: 'Send' })), false);
  assert.equal(isGeminiSendControl(control({ tagName: 'MAT-ICON', inComposer: true })), false);
  assert.equal(isGeminiStopControl(control({ tagName: 'BUTTON', inComposer: true })), true);
  assert.equal(isGeminiStopControl(control({ tagName: 'BUTTON', ariaLabel: 'Stop' })), false);
  assert.equal(GEMINI_SEND_SELECTORS.includes('.action-wrapper button[aria-label]'), false);
});

test('Gemini submission evidence selectors include alternative user bubble markup', () => {
  assert.ok(GEMINI_USER_MESSAGE_SELECTORS.includes('[data-testid="user-message"]'));
  assert.ok(GEMINI_USER_MESSAGE_SELECTORS.includes('[data-message-author-role="user"]'));
});

test('Gemini confirms the full prompt despite the hidden You said preview and preserves quoted spaces', () => {
  const prompt = 'Answer briefly.\nKeep "a  b" exactly.';
  const bubble = {
    innerText: `You said Answer briefly. Keep…\n${prompt}`,
    querySelectorAll: (selector: string) => selector === '.query-text-line'
      ? [{ textContent: ' Answer briefly. ' }, { textContent: '' }, { textContent: ' Keep "a  b" exactly. ' }]
      : [],
  } as unknown as Element;
  assert.equal(contentMatchesPrompt((bubble as HTMLElement).innerText, prompt), false);
  assert.equal(contentMatchesPrompt(readGeminiUserMessageText(bubble), prompt), true);
  assert.equal(contentMatchesPrompt(readGeminiUserMessageText(bubble), 'Answer briefly.\nKeep "a b" exactly.'), false);
  assert.equal(contentMatchesPrompt(readGeminiUserMessageText(bubble), 'A different prompt'), false);
});
