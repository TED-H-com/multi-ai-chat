import { createContentScript } from './base';
import { injectMetaInput } from './metaInput';
import {
  META_INPUT_SELECTORS,
  META_RESPONSE_SELECTORS,
  META_SEND_SELECTORS,
  META_STOP_SELECTORS,
  isUsableMetaControl,
  isVisibleMetaElement,
  isMetaLoginLabel,
  isMetaSendControl,
  isMetaStopControl,
  isMetaGenerationActive,
  metaLoginStatus,
} from './metaDom';

const inputs = () => Array.from(document.querySelectorAll(META_INPUT_SELECTORS.join(', ')));
const loginStatus = () => metaLoginStatus(
  inputs(),
  (input) => isVisibleMetaElement(input as Element),
  Array.from(document.querySelectorAll('[data-testid="login-button"]')).some(isVisibleMetaElement),
  Array.from(document.querySelectorAll('[role="dialog"]')).some((dialog) => (
    isVisibleMetaElement(dialog)
    && Array.from(dialog.querySelectorAll('button, [role="button"], a')).some((control) => (
      isVisibleMetaElement(control)
      && (control.getAttribute('data-testid') === 'login-button'
        || isMetaLoginLabel(control.getAttribute('aria-label') || control.textContent || ''))
    ))
  )),
);

createContentScript({
  provider: 'meta',
  inputSelectors: META_INPUT_SELECTORS,
  requireVisibleInput: true,
  inputFilter: isUsableMetaControl,
  injectInput: injectMetaInput,
  sendButtonSelectors: META_SEND_SELECTORS,
  sendButtonFilter: isMetaSendControl,
  responseSelectors: META_RESPONSE_SELECTORS,
  responseTracking: 'semantic-latest',
  stopButtonSelectors: META_STOP_SELECTORS,
  stopButtonFilter: isMetaStopControl,
  loginDetector: loginStatus,
  loggedOutDetector: () => loginStatus() === false,
  loginLossDelay: 2500,
  isThinking: () => isMetaGenerationActive(
    Array.from(document.querySelectorAll(META_STOP_SELECTORS.join(', '))),
    (element) => isVisibleMetaElement(element as Element),
  ),
  streamWhileThinking: true,
  doneDelay: 5000,
  chunkDebounce: 600,
});
