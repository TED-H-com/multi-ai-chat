// Meta's hydrated textarea and Lexical editor share this test id. The original
// prehydration attribute is conditional and is absent from the rich editor.
export const META_INPUT_SELECTORS = [
  '[data-testid="composer-input"][contenteditable="true"]',
  'textarea[data-testid="composer-input"]',
  'input[data-testid="composer-input"]',
  'input[aria-label="Ask Meta AI"]',
  'textarea[aria-label="Ask Meta AI"]',
  'textarea[aria-label^="Ask Meta AI" i]',
  'textarea[data-ecto-composer-prehydration-input]',
  'textarea[placeholder^="Ask Meta AI" i]',
  'input[placeholder^="Ask Meta AI" i]',
  '[contenteditable="true"][aria-label^="Ask Meta AI" i]',
  '[contenteditable="true"][aria-placeholder^="Ask Meta AI" i]',
  '[contenteditable="true"][role="textbox"]',
];
export const META_SEND_SELECTORS = ['[data-testid="composer-send-button"]', 'button[aria-label="Send"]'];
export const META_STOP_SELECTORS = ['[data-testid="composer-stop-button"]', 'button[aria-label="Stop"]'];
export const META_RESPONSE_SELECTORS = ['[data-message-item]:not([data-user-message])', '[data-testid="assistant-message"]'];

export function metaResponseContentRoot(response: Element): Element | Element[] {
  if (response.matches?.('.ur-markdown, pre')) return response;
  // Meta renders prose and code in separate sibling fragments. Keep all answer
  // fragments in DOM order, without the surrounding thinking/copy/fold controls.
  const fragments = Array.from(response.querySelectorAll?.('.ur-markdown, pre') ?? []);
  const roots: Element[] = [];
  for (const fragment of fragments) {
    // Expanded code retains a hidden five-line preview beside the full PRE.
    if (fragment.closest?.('.hidden, [hidden], [aria-hidden="true"]')) continue;
    if (!roots[roots.length - 1]?.contains(fragment)) roots.push(fragment);
  }
  return roots.length ? roots : response;
}

export function isMetaResponseStreaming(response?: Element): boolean {
  if (!response) return false;
  const body = response.getAttribute?.('data-streaming-state')
    ? response : response.querySelector?.('[data-streaming-state]');
  const state = body?.getAttribute('data-streaming-state');
  return Boolean(state && state !== 'DONE');
}

export function isMetaResponseCandidate(response: Element): boolean {
  if (isMetaResponseStreaming(response)) return false;
  const hasAnswer = Boolean(response.querySelector?.('.ur-markdown, pre'));
  if (response.getAttribute?.('data-message-role') === 'assistant'
    || response.getAttribute?.('data-testid') === 'assistant-message'
    || response.querySelector?.('[data-testid="assistant-message"]')) return hasAnswer;
  // The current outer turn mounts its thinking status before the answer. Do not
  // mistake its invisible orbit logo/canvas for generated media either.
  return !response.querySelector?.('[data-testid="thinking-status"], img[src*="/images/cot_logo_static/"]')
    || hasAnswer;
}

const expandedMetaCodeControls = new WeakSet<Element>();

export function prepareMetaResponse(response: Element): boolean {
  const controls = Array.from(response.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
    .filter((button) => /^See all \d+ lines$/i.test(button.getAttribute('aria-label') ?? '')
      && button.getAttribute('aria-expanded') !== 'true');
  for (const button of controls) {
    // Only expand the answer's code preview. Never activate Copy, Download,
    // Retry, Send, or a control outside this response. Wait for React to mount
    // the remaining lines before allowing any text into the workflow.
    if (!button.disabled && !expandedMetaCodeControls.has(button)) {
      expandedMetaCodeControls.add(button);
      button.click();
    }
  }
  return controls.length === 0;
}

const META_COMPOSER_CONTAINER = '[data-testid*="composer"], [class*="composer"], [class*="input-area"], form, fieldset';

interface MetaControl {
  disabled?: boolean;
  readOnly?: boolean;
  closest(selector: string): unknown;
  getAttribute?(name: string): string | null;
}

interface QueryCapableContainer {
  querySelector(selectors: string): unknown;
  querySelectorAll?(selectors: string): ArrayLike<unknown>;
}

export function isUsableMetaControl(element: MetaControl): boolean {
  return !element.disabled && !element.readOnly && !element.closest(
    '[inert], [disabled], [data-disabled="true"], [readonly], [aria-readonly="true"], [aria-disabled="true"], [aria-hidden="true"]',
  );
}

export function isVisibleMetaElement(element: Element): boolean {
  const style = window.getComputedStyle(element);
  // Opacity is self-only, like the desktop helper: an opacity: 0 ancestor still
  // reports opacity: 1 on its children.
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && !(style.opacity !== '' && Number(style.opacity) === 0)
    && element.getClientRects().length > 0;
}

export function metaSessionReady(inputs: readonly MetaControl[], isVisible: (element: MetaControl) => boolean): boolean {
  // An enabled guest composer is usable too. A login link alone does not make it unusable.
  return inputs.some((input) => isVisible(input) && isUsableMetaControl(input));
}

export function metaLoginStatus(
  inputs: readonly MetaControl[],
  isVisible: (element: MetaControl) => boolean,
  hasVisibleLoginButton: boolean,
  hasVisibleLoginWall = false,
): boolean | null {
  // A usable composer wins. After Facebook/Instagram login the page can still
  // expose a login control or an inert prehydration field beside the real editor.
  if (metaSessionReady(inputs, isVisible)) return true;
  if (hasVisibleLoginWall || hasVisibleLoginButton || inputs.some((input) => isVisible(input) && input.closest('[inert]'))) return false;
  // Missing/remounting/temporarily disabled editors are not evidence of logout.
  return null;
}

export function isMetaLoginLabel(text: string): boolean {
  return /^(?:log in|sign in|登入|登录|ログイン|anmelden|로그인)$/i.test(text.trim());
}

export function isMetaSendControl(element: MetaControl): boolean {
  return isMetaComposerAction(element, 'composer-send-button');
}

export function isMetaStopControl(element: MetaControl): boolean {
  return isMetaComposerAction(element, 'composer-stop-button');
}

export function isMetaGenerationActive(
  stops: readonly MetaControl[],
  isVisible: (element: MetaControl) => boolean,
): boolean {
  return stops.some((element) => isVisible(element) && isMetaStopControl(element));
}

function isMetaComposerAction(element: MetaControl, explicitTestId: string): boolean {
  if (!isUsableMetaControl(element)) return false;
  if (element.getAttribute?.('data-testid') === explicitTestId) return true;
  const container = element.closest(META_COMPOSER_CONTAINER) as QueryCapableContainer | null;
  return Boolean(container && containerHasUsableMetaInput(container));
}

function containerHasUsableMetaInput(container: QueryCapableContainer): boolean {
  const candidates = container.querySelectorAll
    ? Array.from(container.querySelectorAll(META_INPUT_SELECTORS.join(', ')))
    : [container.querySelector(META_INPUT_SELECTORS.join(', '))];
  return candidates.some((candidate) => candidate != null && isUsableMetaControl(candidate as MetaControl));
}
