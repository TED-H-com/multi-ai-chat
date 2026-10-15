import { createContentScript } from './base';
import {
  CHATGPT_ACCOUNT_SELECTORS,
  CHATGPT_INPUT_SELECTORS,
  CHATGPT_LOGGED_OUT_SELECTORS,
  CHATGPT_STOP_SELECTORS,
  CHATGPT_USER_MESSAGE_SELECTORS,
  isChatGptSendControl,
  isChatGptStopControl,
  isIncompleteChatGptAssistantTurn,
  isUsableChatGptComposerInput,
} from './chatgptDom';

function hasVisibleElement(
  selectors: readonly string[],
  filter: (element: Element) => boolean = () => true,
): boolean {
  return selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some((element) => {
    if (filter(element) === false) return false;
    if (!(element instanceof HTMLElement)) return true;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden'
      && !(style.opacity !== '' && Number(style.opacity) === 0)
      && element.getClientRects().length > 0;
  }));
}

function chatGptLoginStatus(): boolean | null {
  // Guests also have a composer. Require account UI as well as an editable input,
  // and reserve Sign in for explicit login/signup evidence.
  if (hasVisibleElement(CHATGPT_LOGGED_OUT_SELECTORS)) return false;
  // The account menu can remain mounted inside a collapsed sidebar.
  if (CHATGPT_ACCOUNT_SELECTORS.some(selector => document.querySelectorAll(selector).length > 0)
    && hasVisibleElement(CHATGPT_INPUT_SELECTORS, isUsableChatGptComposerInput)) return true;
  // Hydration, SPA remounts and unrecognized markup are unknown, not a logout.
  return null;
}

createContentScript({
  provider: 'chatgpt',

  // ChatGPT's prompt input (contenteditable div in 2026)
  inputSelectors: CHATGPT_INPUT_SELECTORS,
  requireVisibleInput: true,
  inputFilter: isUsableChatGptComposerInput,

  sendButtonSelectors: [
    '[data-testid="send-button"]',
    '#composer-submit-button',
    'button[data-testid*="composer-send"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
  ],
  sendButtonFilter: isChatGptSendControl,
  userMessageSelectors: CHATGPT_USER_MESSAGE_SELECTORS,
  requireSameComposerForClearConfirmation: true,

  // Response container — ChatGPT uses multiple assistant messages
  // (thinking messages + final response all share the same structure)
  responseSelectors: [
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"]',
  ],
  // ChatGPT can remount the latest assistant turn while it transitions from
  // streaming to complete. Compare semantic turn growth/text rather than DOM
  // element identity so a visible remounted response is still collected.
  responseTracking: 'semantic-latest',

  stopButtonSelectors: CHATGPT_STOP_SELECTORS,
  stopButtonFilter: isChatGptStopControl,

  loginDetector: chatGptLoginStatus,
  loggedOutDetector: () => chatGptLoginStatus() === false,

  // Detect if ChatGPT is still generating/thinking/searching
  // Key insight: when ChatGPT is still working, a "stop" button is visible
  isThinking: () => {
    // Check for stop/cancel button — if it exists, ChatGPT is still working
    if (hasVisibleElement(CHATGPT_STOP_SELECTORS, isChatGptStopControl)) return true;
    // The stop button is only mounted while tokens are actively arriving: it is removed before
    // the last render commits, and it can vanish entirely between the phases of a multi-step
    // answer (search, reasoning). On its own it lets a pause longer than doneDelay read as
    // "finished". A turn only grows a copy button once its message is complete (no hover
    // needed), so use that to cover the gaps the stop button leaves.
    // Note: this pins us to ChatGPT's copy-turn-action-button testid. If it is renamed we wait
    // until the background 600s timeout and surface an error — loud beats silently shipping
    // half an answer into the next provider's prompt.
    const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    const lastTurn = turns[turns.length - 1];
    return Boolean(lastTurn && isIncompleteChatGptAssistantTurn(lastTurn));
  },

  // ChatGPT needs longer done delay because of multi-step thinking
  doneDelay: 3000,
  chunkDebounce: 800,
});
