interface GeminiControl {
  tagName: string;
  isContentEditable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  getAttribute(name: string): string | null;
  matches(selectors: string): boolean;
  closest(selectors: string): unknown;
}

interface QueryCapableContainer {
  querySelector(selectors: string): unknown;
}

export const GEMINI_INPUT_SELECTORS = [
  'rich-textarea .ql-editor[contenteditable="true"]',
  'div[contenteditable="true"][aria-label="Enter a prompt here"]',
  '.input-area [contenteditable="true"]',
  'rich-textarea [contenteditable="true"]',
];

export const GEMINI_SEND_SELECTORS = [
  'button.send-button',
  'button[aria-label="Send message"]',
  'button[aria-label="Send"]',
  'button[aria-label="傳送訊息"]',
  'button[aria-label="送出"]',
  'button[data-mat-icon-name="send"]',
  '.send-button-container button',
  '.input-area-container button.send',
  'button.send-message-button',
];

export const GEMINI_STOP_SELECTORS = [
  'button[aria-label="Stop response"]',
  'button[aria-label="Stop"]',
  'button[aria-label="停止回應"]',
];

const COMPOSER_CONTAINER = 'rich-textarea, .input-area, .input-area-container, .send-button-container';

export function isUsableGeminiComposerInput(element: GeminiControl): boolean {
  const editable = element.isContentEditable || element.getAttribute('contenteditable') === 'true';
  // A Quill class alone also appears in unrelated editors. Accept the legacy
  // labelled composer, or an editable inside one of Gemini's composer scopes.
  const composer = element.getAttribute('aria-label') === 'Enter a prompt here'
    || Boolean(element.closest('rich-textarea, .input-area'));
  return Boolean(editable && composer && !element.disabled && !element.readOnly
    && element.getAttribute('aria-disabled') !== 'true' && element.getAttribute('aria-readonly') !== 'true'
    && !element.closest('[inert], [disabled], [readonly], [data-disabled="true"], [aria-disabled="true"], [aria-readonly="true"], [aria-hidden="true"]'));
}

export function isGeminiSendControl(element: GeminiControl): boolean {
  return element.tagName === 'BUTTON' && (
    element.matches('button.send-button, button.send-message-button, button[data-mat-icon-name="send"]')
    || isWithinComposer(element)
  );
}

export function isGeminiStopControl(element: GeminiControl): boolean {
  return element.tagName === 'BUTTON' && isWithinComposer(element);
}

export function isVisibleGeminiElement(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden'
    && !(style.opacity !== '' && Number(style.opacity) === 0)
    && element.getClientRects().length > 0;
}

function isWithinComposer(element: GeminiControl): boolean {
  if (element.closest(COMPOSER_CONTAINER)) return true;
  const form = element.closest('form') as QueryCapableContainer | null;
  return Boolean(form?.querySelector(GEMINI_INPUT_SELECTORS.join(', ')));
}
