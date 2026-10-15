interface ClosestCapableElement {
  disabled?: boolean;
  readOnly?: boolean;
  getAttribute(name: string): string | null;
  closest(selectors: string): unknown;
  matches?(selectors: string): boolean;
}

interface QueryCapableContainer {
  querySelector(selectors: string): unknown;
}

export interface GrokAssistantSignals {
  streaming: boolean;
  thinkingTexts: readonly string[];
}

export const GROK_INPUT_SELECTORS = [
  '[data-testid="chat-input"] textarea[aria-label="Ask Grok anything"]',
  'textarea[aria-label="Ask Grok anything"]',
  '[data-testid="chat-input"] textarea',
  '[data-testid="chat-input"] .ProseMirror[contenteditable="true"]',
  '[data-testid="chat-input"] [contenteditable="true"]',
  '.ProseMirror[contenteditable="true"]',
];

export const GROK_STOP_SELECTORS = [
  'button[data-testid="chat-stop"]',
  'button[data-testid="chat-stop-button"]',
  'button[aria-label="Stop"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop response"]',
];

export const GROK_REQUIRE_SAME_COMPOSER_FOR_CLEAR_CONFIRMATION = true;
export const GROK_REQUIRE_MATCHING_USER_MESSAGE_FOR_GENERATION_SIGNALS = true;
export const GROK_ANCHOR_RESPONSES_AFTER_MATCHING_USER_MESSAGE = true;

export function isGrokComposerInput(element: ClosestCapableElement): boolean {
  if (element.disabled || element.readOnly || element.getAttribute('disabled') !== null
    || element.getAttribute('readonly') !== null || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('contenteditable') === 'false') return false;
  return element.getAttribute('aria-label') === 'Ask Grok anything'
    || Boolean(element.closest('[data-testid="chat-input"]'))
    || Boolean(element.matches?.('.ProseMirror[contenteditable="true"]'));
}

export function isGrokSendControl(element: ClosestCapableElement): boolean {
  if (element.getAttribute('data-testid') === 'chat-submit') return true;
  if (element.closest('[data-testid="chat-input"]')) return true;
  const form = element.closest('form') as QueryCapableContainer | null;
  return Boolean(form?.querySelector('[data-testid="chat-input"], textarea[aria-label="Ask Grok anything"], .ProseMirror[contenteditable="true"]'));
}

export function isGrokStopControl(element: ClosestCapableElement): boolean {
  const testId = element.getAttribute('data-testid');
  if (testId === 'chat-stop' || testId === 'chat-stop-button') return true;
  if (element.closest('[data-testid="chat-input"]')) return true;
  const form = element.closest('form') as QueryCapableContainer | null;
  return Boolean(form?.querySelector('[data-testid="chat-input"], textarea[aria-label="Ask Grok anything"], .ProseMirror[contenteditable="true"]'));
}

export function isGrokGenerationActive<T>(
  stopControls: readonly T[],
  assistantTurns: readonly T[],
  isVisible: (element: T) => boolean,
  readAssistantSignals: (turn: T) => GrokAssistantSignals,
): boolean {
  if (stopControls.some(isVisible)) return true;

  // Historical reasoning containers remain mounted in long conversations. Only the latest
  // visible assistant turn can describe the generation state of the request being awaited.
  const currentTurn = Array.from(assistantTurns).reverse().find(isVisible);
  if (!currentTurn) return false;
  const signals = readAssistantSignals(currentTurn);
  return signals.streaming || signals.thinkingTexts.some(isActiveThinkingText);
}

export function updateGrokTextControl(
  control: { value: string },
  text: string,
  setNativeValue: (value: string) => void,
  dispatchInput: (value: string) => void,
): void {
  setNativeValue(text);
  dispatchInput(text);
}

export function grokResponseContentRoot(response: Element): Element {
  if (response.matches?.('.response-content-markdown')) return response;
  return response.querySelector?.('.response-content-markdown') ?? response;
}

export function grokSessionReady(
  hasVisibleComposer: boolean,
  hasVisibleGenerationUi: boolean,
): boolean | null {
  return hasVisibleComposer || hasVisibleGenerationUi ? true : null;
}

function isActiveThinkingText(text: string): boolean {
  return text.includes('Thinking') && !text.includes('Thought for');
}
