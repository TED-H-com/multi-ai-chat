import { createContentScript } from './base';
import { injectGeminiInput, readGeminiComposerText, geminiComposerMatches } from './geminiInput';
import {
  GEMINI_INPUT_SELECTORS,
  GEMINI_SEND_SELECTORS,
  GEMINI_STOP_SELECTORS,
  isUsableGeminiComposerInput,
  isGeminiSendControl,
  isGeminiStopControl,
  isVisibleGeminiElement,
} from './geminiDom';

function hasVisibleElement(selectors: readonly string[], filter: (element: Element) => boolean = () => true): boolean {
  return Array.from(document.querySelectorAll(selectors.join(', ')))
    .some(element => isVisibleGeminiElement(element) && filter(element));
}

createContentScript({
  provider: 'gemini',

  inputSelectors: GEMINI_INPUT_SELECTORS,
  requireVisibleInput: true,
  inputFilter: element => isVisibleGeminiElement(element) && isUsableGeminiComposerInput(element),
  readInputText: readGeminiComposerText,
  inputMatchesPrompt: geminiComposerMatches,
  preserveExistingDraft: true,
  sendConfirmation: 'single-activation',
  // The verified click must not wait on a timer: Chrome can defer timers in a
  // background provider tab, which otherwise leaves a valid draft unsent until
  // the user visits Gemini.
  immediateSendAfterInsertion: true,

  sendButtonSelectors: GEMINI_SEND_SELECTORS,
  sendButtonFilter: element => isVisibleGeminiElement(element) && isGeminiSendControl(element),

  responseSelectors: [
    // Gemini response containers
    '.model-response-text .markdown',
    '.model-response-text',
    'model-response .markdown',
    'model-response message-content',
    // Newer Gemini
    '.response-content .markdown',
    '.message-content[data-message-id]',
  ],
  responseTracking: 'semantic-latest',

  stopButtonSelectors: GEMINI_STOP_SELECTORS,
  stopButtonFilter: element => isVisibleGeminiElement(element) && isGeminiStopControl(element),

  loginDetector: () => {
    // Missing markup can mean loading, navigation or usage gating, not logout.
    return hasVisibleElement(GEMINI_INPUT_SELECTORS, isUsableGeminiComposerInput) ? true : null;
  },

  // Detect if Gemini is still generating (thinking indicator or stop button)
  isThinking: () => {
    // Gemini shows a loading/thinking indicator while generating
    if (hasVisibleElement(['.loading-indicator', '.thinking-indicator', 'mat-progress-bar'])) return true;
    // Stop button visible during generation
    if (hasVisibleElement(GEMINI_STOP_SELECTORS, isGeminiStopControl)) return true;
    // Gemini's streaming dots
    if (hasVisibleElement(['.response-streaming', '[data-test-id="response-loading"]'])) return true;
    return false;
  },

  injectInput: injectGeminiInput,

  doneDelay: 4000,
  chunkDebounce: 600,
});
