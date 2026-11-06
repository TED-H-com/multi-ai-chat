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

// Explicit blocking card observed after a guest submission, not the ordinary
// sign-up link that is also present while the guest composer is usable.
export const GROK_LOGGED_OUT_SELECTORS = ['[data-testid="anon-paywall-sign-up-card"]'];

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

/**
 * Read the same visual/editor content used for send verification. ProseMirror
 * renders paragraphs as DOM blocks: textContent concatenates them while
 * innerText adds layout line breaks. Both are legitimate representations of
 * the exact typed prompt, so compare their formatting without discarding
 * significant spaces inside quoted text.
 */
export function readGrokComposerText(input: Element): string {
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return (input as HTMLTextAreaElement).value;
  const editor = input as HTMLElement;
  return editor.innerText || editor.textContent || '';
}

export function grokComposerMatches(input: Element, expected: string): boolean {
  const normalizeEndings = (value: string) => value.replace(/\r\n?/g, '\n');
  const visual = normalizeEndings(readGrokComposerText(input));
  const raw = normalizeEndings(input.textContent ?? '');
  return normalizedComposerText(visual) === normalizedComposerText(expected)
    || normalizedComposerText(raw) === normalizedComposerText(expected);
}

// Layout whitespace can differ between a ProseMirror editor's innerText and
// textContent. Preserve literal whitespace inside quoted strings, and never
// remove content characters or ignore differences between words.
function normalizedComposerText(value: string): string {
  const literals = /"(?:\\.|[^"\\])*"|(?<![\p{L}\p{N}_])'(?:\\.|[^'\\])*'(?![\p{L}\p{N}_])/gu;
  let result = '';
  let end = 0;
  for (const match of value.matchAll(literals)) {
    result += value.slice(end, match.index).replace(/\s+/g, ' ') + match[0];
    end = match.index + match[0].length;
  }
  return (result + value.slice(end).replace(/\s+/g, ' ')).trim();
}

export function grokResponseContentRoot(response: Element): Element {
  if (response.matches?.('.response-content-markdown')) return response;
  return response.querySelector?.('.response-content-markdown') ?? response;
}

export function isGrokAssistantResponseCandidate(response: Element): boolean {
  // Both user and assistant bubbles use response-content-markdown. A fallback
  // match inside the newly accepted user bubble is still the prompt, not a reply.
  return !response.closest('[data-testid="user-message"], [data-message-author-role="user"], .message-bubble.user');
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
