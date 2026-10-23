interface ClosestCapableElement {
  id: string;
  closest(selectors: string): unknown;
  getAttribute(name: string): string | null;
  matches?(selectors: string): boolean;
  ownerDocument?: Document;
}

interface QueryCapableContainer {
  querySelector(selectors: string): unknown;
  querySelectorAll?(selectors: string): NodeListOf<Element>;
}

interface ChatGptComposerElement extends ClosestCapableElement {
  tagName: string;
  isContentEditable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
}

interface ChatGptTurnElement {
  matches(selectors: string): boolean;
  querySelector(selectors: string): unknown;
}

export const CHATGPT_INPUT_SELECTORS = [
  '#prompt-textarea',
  '.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][data-placeholder]',
];

export const CHATGPT_LOGGED_OUT_SELECTORS = [
  '[data-testid="login-button"]',
  '[data-testid="signup-button"]',
  'a[href^="/auth/login"]',
  'a[href^="/auth/signup"]',
];

export const CHATGPT_ACCOUNT_SELECTORS = [
  'button[data-testid="accounts-profile-button"]',
  'button[aria-label="Open profile menu"]',
];

export const CHATGPT_STOP_SELECTORS = [
  '[data-testid="stop-button"]',
  '[data-testid="composer-stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop"]',
];

export const CHATGPT_USER_MESSAGE_SELECTORS = [
  '[data-message-author-role="user"]',
  '[data-user-message-bubble] [data-search-result-target]',
];

export const CHATGPT_RESPONSE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-testid="assistant-message"]',
  '[data-message-author-role="assistant"] .markdown',
  '[data-message-author-role="assistant"] .prose',
  '[data-testid="assistant-message"] .markdown',
  '[data-testid^="conversation-turn-"]',
  // Observed in the current signed-in web layout, which has no legacy
  // message-role or conversation-turn test IDs.
  '[data-markdown-text-style="assistant-message"]',
];

const EXPLICIT_COMPOSER_SELECTOR = '[data-testid*="composer"], form[data-type="unified-composer"], form[data-chatgpt-composer]';
const NON_COMPOSER_SELECTOR = [
  '[data-message-author-role]', '[data-testid^="conversation-turn-"]', 'article',
  'dialog', '[role="dialog"]', '[role="search"]', 'nav', 'aside',
  '[inert]', '[disabled]', '[readonly]', '[aria-disabled="true"]',
  '[aria-readonly="true"]', '[aria-hidden="true"]',
].join(', ');
const COMPOSER_ACTION_SELECTOR = [
  '[data-testid="send-button"]',
  '#composer-submit-button',
  'button[data-testid*="composer-send"]',
  '[data-testid="stop-button"]',
  '[data-testid="composer-stop-button"]',
].join(', ');

function isWithinChatGptComposer(element: ClosestCapableElement): boolean {
  if (element.closest(EXPLICIT_COMPOSER_SELECTOR)) return true;
  const form = element.closest('form') as QueryCapableContainer | null;
  return Boolean(form?.querySelector(COMPOSER_ACTION_SELECTOR))
    || Array.from(form?.querySelectorAll?.('.ProseMirror[contenteditable="true"]') ?? [])
      .some(isUnmarkedChatGptComposer);
}

function isUnmarkedChatGptComposer(element: ClosestCapableElement): boolean {
  const doc = element.ownerDocument;
  if (!doc?.defaultView
    || !element.matches?.('.ProseMirror[contenteditable="true"]')
    || !element.closest('form') || element.closest(NON_COMPOSER_SELECTOR)) return false;

  // Empty composers can omit both the old markers and the Send button. Accept
  // only the sole visible editor outside message edits, dialogs and navigation.
  // A second candidate (including a marked composer) makes this fallback unsafe.
  const candidates = Array.from(doc.querySelectorAll(CHATGPT_INPUT_SELECTORS.join(', '))).filter(candidate => {
    if (candidate.closest(NON_COMPOSER_SELECTOR)) return false;
    const style = doc.defaultView!.getComputedStyle(candidate);
    return style.display !== 'none' && style.visibility !== 'hidden' && candidate.getClientRects().length > 0;
  });
  return candidates.length === 1 && candidates[0] === element;
}

export function isChatGptComposerInput(element: ClosestCapableElement): boolean {
  return element.id === 'prompt-textarea' || isWithinChatGptComposer(element);
}

export function isUsableChatGptComposerInput(element: ChatGptComposerElement): boolean {
  const editable = element.isContentEditable || element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';
  return isChatGptComposerInput(element) && editable && !element.disabled && !element.readOnly
    && !element.closest('[inert], [disabled], [readonly], [data-disabled="true"], [aria-disabled="true"], [aria-readonly="true"], [aria-hidden="true"]');
}

export function isChatGptSendControl(element: ClosestCapableElement): boolean {
  const testId = element.getAttribute('data-testid');
  return element.id === 'composer-submit-button'
    || testId === 'send-button'
    || Boolean(testId?.includes('composer-send'))
    || isWithinChatGptComposer(element);
}

export function isChatGptStopControl(element: ClosestCapableElement): boolean {
  const testId = element.getAttribute('data-testid');
  return testId === 'stop-button'
    || testId === 'composer-stop-button'
    || isWithinChatGptComposer(element);
}

// ChatGPT sometimes places the assistant reply inside a conversation-turn wrapper,
// while older builds expose data-message-author-role directly. The outer wrapper
// is a safe fallback only when it demonstrably belongs to an assistant turn:
// a generic conversation-turn wrapper may contain a user prompt instead.
export function isChatGptAssistantResponseTurn(turn: ChatGptTurnElement): boolean {
  return turn.matches('[data-message-author-role="assistant"], [data-testid="assistant-message"], [data-turn="assistant"], [data-role="assistant"]')
    || Boolean(turn.querySelector('[data-message-author-role="assistant"]'))
    || Boolean(turn.querySelector('[data-testid="assistant-message"], [data-turn="assistant"], [data-role="assistant"]'));
}

export function chatGptResponseContentRoot(response: Element): Element {
  if (response.matches('[data-testid^="conversation-turn-"]')) {
    // Do not serialize the surrounding turn's status/actions as answer text.
    return response.querySelector('[data-message-author-role="assistant"], [data-testid="assistant-message"], [data-turn="assistant"], [data-role="assistant"]') ?? response;
  }
  return response;
}

export function isIncompleteChatGptAssistantTurn(turn: ChatGptTurnElement): boolean {
  const assistant = isChatGptAssistantResponseTurn(turn);
  return assistant && !turn.querySelector('[data-testid="copy-turn-action-button"]');
}
