import { createContentScript } from './base';
import { focusWithoutScroll } from './focusWithoutScroll';
import {
  GROK_ANCHOR_RESPONSES_AFTER_MATCHING_USER_MESSAGE,
  GROK_INPUT_SELECTORS,
  GROK_LOGGED_OUT_SELECTORS,
  GROK_REQUIRE_MATCHING_USER_MESSAGE_FOR_GENERATION_SIGNALS,
  GROK_REQUIRE_SAME_COMPOSER_FOR_CLEAR_CONFIRMATION,
  GROK_STOP_SELECTORS,
  isGrokComposerInput,
  isGrokGenerationActive,
  isGrokStopControl,
  isGrokSendControl,
  grokComposerMatches,
  readGrokComposerText,
  grokResponseContentRoot,
  isGrokAssistantResponseCandidate,
  grokSessionReady,
  updateGrokTextControl,
} from './grokDom';
import { readGrokUserMessageText } from './grokUserMessage';

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden'
    && !(style.opacity !== '' && Number(style.opacity) === 0) && element.getClientRects().length > 0;
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
  readInputText: readGrokComposerText,
  inputMatchesPrompt: grokComposerMatches,

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
  userMessageText: readGrokUserMessageText,
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
  responseFilter: isGrokAssistantResponseCandidate,

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
  loggedOutDetector: () => queryAll(GROK_LOGGED_OUT_SELECTORS).some(isVisible),

  isThinking: grokGenerationActive,

  // Grok has both a native textarea and a ProseMirror editor. One native edit
  // is safer than synthetic DOM replacement: replacing React/ProseMirror-owned
  // nodes can look right for a frame, but React restores its state before Send.
  injectInput: async (el: Element, text: string, isActive: () => boolean = () => true) => {
    const editor = el as HTMLElement;
    focusWithoutScroll(editor);
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
    if (readGrokComposerText(el).trim()) throw new Error('live editor contains different text');
    const selection = window.getSelection();
    if (!selection || typeof document.execCommand !== 'function') {
      throw new Error('native contenteditable insertion unavailable');
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    const accepted = document.execCommand('insertText', false, text);
    // ProseMirror can reconcile the browser's native edit asynchronously.
    // Reading after one microtask alone mistakenly treats an in-progress edit
    // as a different draft, causing the subsequent safe retry to be blocked.
    // Never edit a second time here: the first insertion may have landed.
    const deadline = Date.now() + 4_000;
    while (true) {
      if (!isActive()) throw new Error('request cancelled during native editor reconciliation');
      if (grokComposerMatches(el, text)) return;
      if (!editor.isConnected) throw new Error('editor remounted after native insertion');
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (readGrokComposerText(el).trim()) {
      throw new Error('editor content changed after native insertion');
    }
    throw new Error(accepted
      ? 'native editor lost the requested prompt'
      : 'native editor did not accept the requested prompt');
  },

  // Round 5 of roundtable carries 4 rounds × 4 speakers of history — generation can
  // have natural multi-second pauses. Long doneDelay prevents premature finalization.
  doneDelay: 8000,
  chunkDebounce: 600,
});
