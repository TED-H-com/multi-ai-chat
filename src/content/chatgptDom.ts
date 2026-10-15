interface ClosestCapableElement {
  id: string;
  closest(selectors: string): unknown;
  getAttribute(name: string): string | null;
}

interface QueryCapableContainer {
  querySelector(selectors: string): unknown;
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
];

const EXPLICIT_COMPOSER_SELECTOR = '[data-testid*="composer"], form[data-type="unified-composer"], form[data-chatgpt-composer]';
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
  return Boolean(form?.querySelector(COMPOSER_ACTION_SELECTOR));
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

export function isIncompleteChatGptAssistantTurn(turn: ChatGptTurnElement): boolean {
  const assistant = turn.matches('[data-message-author-role="assistant"]')
    || Boolean(turn.querySelector('[data-message-author-role="assistant"]'));
  return assistant && !turn.querySelector('[data-testid="copy-turn-action-button"]');
}
