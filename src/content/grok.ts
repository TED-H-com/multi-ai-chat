import { createContentScript } from './base';
import {
  GROK_ANCHOR_RESPONSES_AFTER_MATCHING_USER_MESSAGE,
  GROK_INPUT_SELECTORS,
  GROK_REQUIRE_MATCHING_USER_MESSAGE_FOR_GENERATION_SIGNALS,
  GROK_REQUIRE_SAME_COMPOSER_FOR_CLEAR_CONFIRMATION,
  GROK_STOP_SELECTORS,
  isGrokComposerInput,
  isGrokGenerationActive,
  isGrokStopControl,
  isGrokSendControl,
  grokResponseContentRoot,
  grokSessionReady,
  updateGrokTextControl,
} from './grokDom';

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function queryAll(selectors: readonly string[]): Element[] {
  return Array.from(document.querySelectorAll(selectors.join(', ')));
}

function grokGenerationActive(): boolean {
  return isGrokGenerationActive(
    queryAll(GROK_STOP_SELECTORS).filter(isGrokStopControl),
    queryAll(['[data-testid="assistant-message"]', '.message-bubble.assistant']),
    isVisible,
    (turn) => {
      const streamingCandidates = [
        turn,
        ...Array.from(turn.querySelectorAll('[data-streaming="true"], [data-is-streaming="true"]')),
      ];
      const thinkingContainers = Array.from(turn.querySelectorAll('.thinking-container'))
        .filter(isVisible);
      return {
        streaming: streamingCandidates.some((candidate) => (
          isVisible(candidate)
          && (candidate.getAttribute('data-streaming') === 'true'
            || candidate.getAttribute('data-is-streaming') === 'true')
        )),
        thinkingTexts: thinkingContainers.map((container) => container.textContent ?? ''),
      };
    },
  );
}

createContentScript({
  provider: 'grok',

  inputSelectors: GROK_INPUT_SELECTORS,
  requireVisibleInput: true,
  inputFilter: isGrokComposerInput,

  sendButtonSelectors: [
    'button[data-testid="chat-submit"]',
    'button[aria-label="Submit"]',
    'form button[type="submit"]',
    'button[type="submit"]',
  ],
  sendButtonFilter: isGrokSendControl,

  userMessageSelectors: [
    '[data-testid="user-message"]',
  ],
  // Retry sends the exact same prompt again. Count matching turns so a React remount of the
  // failed turn cannot masquerade as confirmation for the new attempt.
  userMessageTracking: 'semantic-count',
  sendConfirmation: 'matching-user-message',
  requireSameComposerForClearConfirmation: GROK_REQUIRE_SAME_COMPOSER_FOR_CLEAR_CONFIRMATION,

  responseSelectors: [
    // Grok marks assistant bubbles with data-testid (most stable)
    '[data-testid="assistant-message"]',
    '[data-testid="assistant-message"] .response-content-markdown',
    // Fallbacks
    '.response-content-markdown',
    '.message-bubble.assistant',
  ],
  // Grok sometimes reuses/remounts its newest assistant bubble. Compare the ordered turn
  // count and latest text instead of relying on Element identity from before the send. A
  // matching new user turn is required before Stop/Thinking/response signals can belong to
  // this request, because a stopped attempt may continue updating the DOM during Retry.
  responseTracking: 'semantic-latest',
  requireMatchingUserMessageForGenerationSignals: GROK_REQUIRE_MATCHING_USER_MESSAGE_FOR_GENERATION_SIGNALS,
  anchorSemanticResponsesAfterMatchingUserMessage: GROK_ANCHOR_RESPONSES_AFTER_MATCHING_USER_MESSAGE,
  responseContentRoot: grokResponseContentRoot,

  stopButtonSelectors: GROK_STOP_SELECTORS,
  stopButtonFilter: isGrokStopControl,

  loginDetector: () => {
    return grokSessionReady(
      queryAll(GROK_INPUT_SELECTORS).some(
        (element) => isVisible(element) && isGrokComposerInput(element),
      ),
      grokGenerationActive(),
    );
  },
  loginLossDelay: 2500,

  isThinking: grokGenerationActive,

  // Grok currently has both textarea and ProseMirror cohorts.
  injectInput: async (el: Element, text: string) => {
    const editor = el as HTMLElement;
    editor.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const prototype = el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      updateGrokTextControl(
        el,
        text,
        (value) => setter ? setter.call(el, value) : (el.value = value),
        (value) => el.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value,
        })),
      );
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    await Promise.resolve();

    if (!matches(editor.textContent ?? '', text)) {
      editor.focus();
      range.selectNodeContents(editor);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      await Promise.resolve();
    }

    if (!matches(editor.textContent ?? '', text)) {
      editor.replaceChildren();
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      editor.appendChild(paragraph);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  },

  // Round 5 of roundtable carries 4 rounds × 4 speakers of history — generation can
  // have natural multi-second pauses. Long doneDelay prevents premature finalization.
  doneDelay: 8000,
  chunkDebounce: 600,
});

function matches(actual: string, expected: string): boolean {
  return actual.replace(/\s+/g, '') === expected.replace(/\s+/g, '');
}
