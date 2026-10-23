import type { AIProvider, ExtensionMessage } from '../shared/types';
import {
  submissionEvidenceForState,
  type ProviderRequestDiagnostics,
  type ProviderRequestState,
} from '../shared/providerRequestState';
import type { SubmissionEvidence } from '../shared/autonomousRecovery';
import { decodeError, encodeError } from '../shared/errors';
import {
  extractResponseContent,
  longerResponseText,
  type ResponseContentRoot,
} from './responseSerializer';
import { isActiveContentRequest, shouldStopContentRequest } from '../shared/requestScope';
import { decideLoginStatus, type LoginStatusState } from './loginStatusStability';
import { focusWithoutScroll } from './focusWithoutScroll';
import { firstAcceptedCandidate } from './elementSelection';
import {
  clearedComposerConfirmsSend,
  contentMatchesPrompt,
  generationSignalBelongsToCurrentTurn,
  matchingPromptCount,
} from './sendConfirmation';
import {
  captureSemanticResponseBaseline,
  currentSemanticResponseText,
  distinctSemanticResponseTurns,
  isActiveResponseGeneration,
  responsesFollowingAnchor,
  type SemanticResponseBaseline,
} from './responseTracking';

export interface ContentScriptConfig {
  provider: AIProvider;
  inputSelectors: string[];
  requireVisibleInput?: boolean;
  inputFilter?: (element: Element) => boolean;
  sendButtonSelectors: string[];
  sendButtonFilter?: (element: Element) => boolean;
  userMessageSelectors?: string[];
  userMessageTracking?: 'element-identity' | 'semantic-count';
  userMessageText?: (element: Element) => string;
  sendConfirmation?: 'heuristic' | 'matching-user-message' | 'single-activation';
  readInputText?: (element: Element) => string;
  inputMatchesPrompt?: (element: Element, text: string) => boolean;
  preserveExistingDraft?: boolean;
  requireSameComposerForClearConfirmation?: boolean;
  responseSelectors: string[];
  responseFilter?: (element: Element) => boolean;
  responseTracking?: 'element-identity' | 'semantic-latest';
  requireMatchingUserMessageForGenerationSignals?: boolean;
  anchorSemanticResponsesAfterMatchingUserMessage?: boolean;
  responseContentRoot?: ResponseContentRoot;
  // Some providers mount only a preview of folded code. Return false until
  // response-local display controls have revealed the complete answer.
  prepareResponse?: (response: Element) => boolean;
  stopButtonSelectors?: string[];
  stopButtonFilter?: (element: Element) => boolean;
  loginDetector: () => boolean | null;
  loggedOutDetector?: () => boolean;
  loginLossDelay?: number;
  isThinking?: () => boolean;
  // Some providers keep their busy/Stop signal active throughout answer streaming.
  // Allow chunks while that signal still prevents premature completion.
  streamWhileThinking?: boolean;
  injectInput?: (element: Element, text: string, isActive?: () => boolean) => void | Promise<void>;
  // Background tabs can have timers aggressively deferred. Providers that use a
  // verified, single-activation Send control can opt into dispatching that first
  // click immediately after controlled-editor readback instead of waiting for
  // the generic cosmetic pre-send delay.
  immediateSendAfterInsertion?: boolean;
  // Longer background-tab acknowledgement window; does not repeat a click.
  sendConfirmationTimeoutMs?: number;
  // Release the delivery reply port after synchronous request reservation.
  // Slow background editor work reports its outcome through scoped events.
  acknowledgeOnRequestStart?: boolean;
  doneDelay?: number;
  chunkDebounce?: number;
}

interface SendActivationResult {
  ok: boolean;
  path: 'button-click' | 'enter-key';
  detail?: string;
  errorKey?: string;
}

interface SettledRequestIdentity {
  requestId?: string;
  workflowId?: string;
  dispatched: boolean;
  reason?: string;
}

interface CancelledRequestCleanup extends SettledRequestIdentity {
  generation: number;
  deadline: number;
  stopActivated: boolean;
  timer?: number;
}

interface CompletedContentRequest {
  requestId: string;
  workflowId: string;
  text: string;
  completedAt: number;
}

const INPUT_RETRY_MS = 250;
const INPUT_TIMEOUT_MS = 2500;
const SEND_BUTTON_TIMEOUT_MS = 800;
const PRE_SEND_DELAY_MS = 800;
const SEND_RETRY_DELAY_MS = 1500;
const SEND_CONFIRMATION_GRACE_MS = 2000;
const SEND_VERIFY_DELAY_MS = 1500;
const STRICT_SEND_CONFIRMATION_TIMEOUT_MS = 10_000;
const CANCELLED_SEND_CLEANUP_TIMEOUT_MS = 10_000;
// 送出成功但完全抓不到回應時，至少等這麼久才放棄。慢的模型（深度思考、搜尋）
// 常常好幾十秒才吐出第一個字，而 isThinking() 只靠硬寫的選擇器，漏判是常態。
// notes: 固定 2 分鐘，遠短於背景的 600 秒逾時；若真出現更慢的模型再拉長
const NO_RESPONSE_GRACE_MS = 120_000;

export function createContentScript(config: ContentScriptConfig): void {
  const marker = `__multiAiChat_${config.provider}`;
  const scope = window as unknown as Record<string, unknown>;
  const existing = scope[marker] as { dispose?: () => void } | undefined;
  try {
    existing?.dispose?.();
  } catch {
    delete scope[marker];
  }
  const runtimeState: { dispose?: () => void } = {};
  scope[marker] = runtimeState;

  const {
    provider,
    inputSelectors,
    requireVisibleInput = false,
    inputFilter = () => true,
    responseSelectors,
    responseTracking = 'element-identity',
    requireMatchingUserMessageForGenerationSignals = false,
    anchorSemanticResponsesAfterMatchingUserMessage = false,
    responseContentRoot = (response) => response,
    userMessageTracking = 'element-identity',
    sendConfirmation = 'heuristic',
    preserveExistingDraft = false,
    loginDetector,
    loggedOutDetector = () => false,
    loginLossDelay = 0,
    isThinking = () => false,
    streamWhileThinking = false,
    injectInput = defaultInjectInput,
    doneDelay = 3000,
    chunkDebounce = 500,
  } = config;

  let statusInterval: ReturnType<typeof setInterval> | undefined;
  let responseTimeout: ReturnType<typeof setTimeout> | undefined;
  let checkDoneInterval: ReturnType<typeof setInterval> | undefined;
  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let responseBaselineEls = new Set<Element>();
  let semanticResponseBaseline: SemanticResponseBaseline = { count: 0, latestText: '' };
  let userMessageBaselineEls = new Set<Element>();
  let matchingUserMessageBaselineCount = 0;
  let sawMatchingUserMessage = false;
  let matchingUserMessageElement: Element | undefined;
  let waitingForResponse = false;
  let lastResponseText = '';
  let lastChunkTime = 0;
  let activeRequestId: string | undefined;
  let activeWorkflowId: string | undefined;
  let responseObserver: MutationObserver | undefined;
  let sawGenerationActivity = false;
  let loginStatusState: LoginStatusState = {};
  let loginStatusTimeout: ReturnType<typeof setTimeout> | undefined;
  let responseWaitStartedAt = 0;
  let activePromptText = '';
  let lastActivatedInput: Element | undefined;
  let disposed = false;
  let responseGeneration = 0;
  let failedRequestTombstone: SettledRequestIdentity | undefined;
  let sendDispatched = false;
  let submissionAccepted = false;
  let thinkingAtRequestStart = false;
  let cancelledRequestCleanup: CancelledRequestCleanup | undefined;
  let recentCompletedRequest: CompletedContentRequest | undefined;
  let lastReportedRequestState: ProviderRequestState | undefined;
  const sendTimeouts = new Set<number>();

  const queryInput = (): Element | null => queryFirst(
    inputSelectors,
    document,
    requireVisibleInput,
    inputFilter,
  );
  const readInputText = config.readInputText
    ?? (sendConfirmation === 'heuristic' ? getInputText : getExactInputText);
  const inputTextMatches = config.inputMatchesPrompt ?? ((input: Element, text: string): boolean => {
    const actual = readInputText(input);
    const normalize = sendConfirmation === 'heuristic' && !preserveExistingDraft
      ? (value: string) => value.replace(/\s+/g, '')
      : (value: string) => value.replace(/\r\n?/g, '\n');
    return normalize(actual) === normalize(text);
  });

  function assertInputLanded(input: Element, expected: string): void {
    if (!readInputText(input).trim()) throw new Error('editor remained empty');
    if (!inputTextMatches(input, expected)) throw new Error('editor text did not match the requested prompt');
  }

  function isContextValid(): boolean {
    if (disposed || scope[marker] !== runtimeState) return false;
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function safeSendMessage(message: ExtensionMessage): void {
    if (!isContextValid()) {
      cleanup();
      return;
    }
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  function reportRequestState(
    state: ProviderRequestState,
    submission: SubmissionEvidence,
    diagnostics?: ProviderRequestDiagnostics,
  ): void {
    if (submission === 'submitted' && sendDispatched) submissionAccepted = true;
    if (!activeRequestId || !activeWorkflowId || (lastReportedRequestState === state && !diagnostics)) return;
    lastReportedRequestState = state;
    safeSendMessage({
      action: 'PROVIDER_REQUEST_STATE',
      provider,
      requestId: activeRequestId,
      workflowId: activeWorkflowId,
      payload: { state, submission, ...(diagnostics ? { diagnostics } : {}) },
    });
  }

  function cleanup(): void {
    if (disposed) return;
    disposed = true;
    waitingForResponse = false;
    activeRequestId = undefined;
    activeWorkflowId = undefined;
    activePromptText = '';
    lastActivatedInput = undefined;
    failedRequestTombstone = undefined;
    recentCompletedRequest = undefined;
    lastReportedRequestState = undefined;
    clearCancelledRequestCleanup();
    clearResponseTimers();
    if (statusInterval !== undefined) clearInterval(statusInterval);
    statusInterval = undefined;
    if (loginStatusTimeout !== undefined) clearTimeout(loginStatusTimeout);
    loginStatusTimeout = undefined;
    responseObserver?.disconnect();
    responseObserver = undefined;
    try {
      chrome.runtime.onMessage.removeListener(runtimeListener);
    } catch {}
    if (scope[marker] === runtimeState) delete scope[marker];
  }

  function reportStatus(force = false): void {
    if (!isContextValid()) {
      cleanup();
      return;
    }
    const explicitlyLoggedOut = loggedOutDetector();
    if (explicitlyLoggedOut && waitingForResponse) {
      finishWithError(encodeError('error.not_ready', { provider }));
    }
    const decision = decideLoginStatus(loginStatusState, {
      ready: loginDetector(),
      explicitlyLoggedOut,
      now: Date.now(),
      lossDelayMs: loginLossDelay,
    });
    loginStatusState = decision.state;

    if (loginStatusTimeout !== undefined) clearTimeout(loginStatusTimeout);
    loginStatusTimeout = undefined;
    if (decision.retryInMs !== undefined) {
      loginStatusTimeout = setTimeout(reportStatus, decision.retryInMs);
    }
    const statusToReport = decision.report !== undefined
      ? decision.report
      : force ? decision.state.reported : undefined;
    if (statusToReport === undefined) return;
    safeSendMessage({ action: 'STATUS_REPORT', provider, payload: { loggedIn: statusToReport } });
  }

  async function sendMessage(text: string, requestId?: string, workflowId?: string): Promise<void> {
    if (!text.trim()) throw new Error(encodeError('error.empty_message'));
    if (waitingForResponse) throw new Error(encodeError('error.response_in_progress', { provider }));
    if (loggedOutDetector()) throw new Error(encodeError('error.not_ready', { provider }));
    if (sendConfirmation === 'single-activation' && isThinking()) {
      throw new Error(encodeError('error.response_in_progress', { provider }));
    }

    // Reserve ownership before the first await so lookup is cancellable and concurrent
    // commands cannot both enter this provider's editor.
    clearCancelledRequestCleanup();
    const generation = ++responseGeneration;
    waitingForResponse = true;
    activeRequestId = requestId;
    activeWorkflowId = workflowId;
    const existingResponses = queryResponses();
    responseBaselineEls = new Set(existingResponses);
    matchingUserMessageElement = undefined;
    semanticResponseBaseline = captureSemanticResponseBaseline(
      querySemanticResponses(),
      extractResponseText,
    );
    userMessageBaselineEls = new Set(queryUserMessages());
    matchingUserMessageBaselineCount = matchingPromptCount(
      Array.from(userMessageBaselineEls, userMessageText),
      text,
    );
    sawMatchingUserMessage = false;
    // This SEND is now the active request. Recovery always consumes a settled failure's
    // tombstone before starting Retry, and no older cleanup may target this newer request.
    failedRequestTombstone = undefined;
    sendDispatched = false;
    submissionAccepted = false;
    lastResponseText = '';
    sawGenerationActivity = false;
    responseWaitStartedAt = Date.now();
    activePromptText = text;
    thinkingAtRequestStart = isThinking();
    lastActivatedInput = undefined;
    lastReportedRequestState = undefined;
    reportRequestState('prompt_inserting', 'not_submitted');
    startResponsePolling();

    const input = await retryLookup(queryInput, INPUT_TIMEOUT_MS, () => isActiveRequest(requestId, generation));
    if (!isActiveRequest(requestId, generation)) throw new Error('request cancelled during input lookup');
    if (!input) {
      const reason = encodeError('error.input_not_found', { provider });
      finishWithError(reason, requestId, workflowId, generation);
      throw new Error(reason);
    }
    if (sendConfirmation === 'single-activation' && isThinking()) {
      const reason = encodeError('error.response_in_progress', { provider });
      finishWithError(reason, requestId, workflowId, generation);
      throw new Error(reason);
    }
    if ((preserveExistingDraft || sendConfirmation === 'matching-user-message') && readInputText(input).trim()
      && !inputTextMatches(input, text)) {
      reportRequestState('existing_draft', 'not_submitted');
      const reason = encodeError('error.existing_draft', { provider });
      finishWithError(reason, requestId, workflowId, generation);
      throw new Error(reason);
    }

    const injectionStartedAt = Date.now();
    try {
      if (!isActiveRequest(requestId, generation)) throw new Error('request cancelled before input injection');
      if ((sendConfirmation === 'heuristic' && !preserveExistingDraft) || !inputTextMatches(input, text)) {
        await injectInput(input, text, () => isActiveRequest(requestId, generation));
      }
      await Promise.resolve();
      if (!isActiveRequest(requestId, generation)) throw new Error('request cancelled during input injection');
      assertInputLanded(input, text);
      reportRequestState('prompt_inserted', 'not_submitted');
    } catch (error) {
      // A native rich-text edit can partially land even when the exact readback
      // fails (notably ProseMirror). Retrying that request into the nonempty
      // editor would collide with its draft. Classify it as an existing draft
      // from the first attempt, rather than triggering another automatic edit.
      const hasUnverifiedDraft = (preserveExistingDraft || sendConfirmation === 'matching-user-message')
        && readInputText(input).trim() !== '' && !inputTextMatches(input, text);
      if (hasUnverifiedDraft) {
        reportRequestState('existing_draft', 'not_submitted');
        finishWithError(encodeError('error.existing_draft', { provider }), requestId, workflowId, generation);
      } else {
        finishWithError(encodeError('error.input_injection_failed', { provider, detail: errorMessage(error) }), requestId, workflowId, generation);
      }
      throw error;
    }

    const beginFirstSendAttempt = async (): Promise<void> => {
      const firstAttempt = await activateSend(text, requestId, generation);
      if (!isActiveRequest(requestId, generation)) return;
      if (sendConfirmation !== 'heuristic') {
        if (!firstAttempt.ok) {
          finishWithError(encodeError(firstAttempt.errorKey ?? 'error.send_failed', {
            provider, ...(firstAttempt.detail ? { detail: firstAttempt.detail } : {}),
          }), requestId, workflowId, generation);
          return;
        }
        // A dispatched click is uncertain until there is positive current-turn evidence.
        // Never refill or activate again while an earlier action may still be accepted.
        scheduleForRequest(() => {
          if (sendStarted()) return;
          finishWithError(encodeError('error.send_unconfirmed', { provider }), requestId, workflowId, generation);
        }, config.sendConfirmationTimeoutMs ?? STRICT_SEND_CONFIRMATION_TIMEOUT_MS, requestId, generation);
        return;
      }
      scheduleForRequest(
        () => void retrySendIfStillPending(text, firstAttempt, requestId, generation),
        SEND_RETRY_DELAY_MS,
        requestId,
        generation,
      );
    };
    if (config.immediateSendAfterInsertion) {
      await beginFirstSendAttempt();
      return;
    }
    const delay = Math.max(0, PRE_SEND_DELAY_MS - (Date.now() - injectionStartedAt));
    scheduleForRequest(() => { void beginFirstSendAttempt(); }, delay, requestId, generation);
  }

  async function retrySendIfStillPending(text: string, firstAttempt: SendActivationResult, requestId: string | undefined, generation: number): Promise<void> {
    if (!isActiveRequest(requestId, generation) || sendStarted()) return;
    if (firstAttempt.ok && await waitForSendConfirmation(requestId, SEND_CONFIRMATION_GRACE_MS, generation)) return;
    if (!isActiveRequest(requestId, generation)) return;
    const retryAttempt = await activateSend(text, requestId, generation);
    if (!isActiveRequest(requestId, generation)) return;
    if (!retryAttempt.ok) {
      finishWithError(encodeError('error.send_failed', { provider, detail: retryAttempt.detail ?? firstAttempt.detail ?? retryAttempt.path }));
      return;
    }
    scheduleForRequest(
      () => void verifySendAfterRetry(text, requestId, generation),
      SEND_VERIFY_DELAY_MS,
      requestId,
      generation,
    );
  }

  async function waitForSendConfirmation(requestId: string | undefined, timeoutMs: number, generation: number): Promise<boolean> {
    const startedAt = Date.now();
    while (isActiveRequest(requestId, generation) && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (isActiveRequest(requestId, generation) && sendStarted()) return true;
    }
    return false;
  }

  async function verifySendAfterRetry(text: string, requestId: string | undefined, generation: number): Promise<void> {
    if (!isActiveRequest(requestId, generation) || sendStarted()) return;
    if (await waitForSendConfirmation(requestId, SEND_CONFIRMATION_GRACE_MS, generation)) return;
    if (!isActiveRequest(requestId, generation)) return;
    let currentInput: Element | null;
    try {
      currentInput = await prepareLiveInput(text, requestId, generation);
    } catch (error) {
      finishWithError(encodeError('error.send_failed', { provider, detail: errorMessage(error) }), requestId, activeWorkflowId, generation);
      return;
    }
    if (!isActiveRequest(requestId, generation)) return;
    if (!currentInput) {
      finishWithError(encodeError('error.input_disappeared', { provider }));
      return;
    }
    lastActivatedInput = currentInput;
    const enterOk = dispatchEnter(currentInput);
    if (enterOk) sendDispatched = true;
    if (!enterOk) {
      finishWithError(encodeError('error.send_failed', { provider, detail: 'Enter dispatch failed' }));
      return;
    }
    scheduleForRequest(() => {
      if (!isActiveRequest(requestId, generation) || sendStarted()) return;
      finishWithError(encodeError('error.send_rejected', { provider }));
    }, SEND_VERIFY_DELAY_MS, requestId, generation);
  }

  async function activateSend(text: string, requestId: string | undefined, generation: number): Promise<SendActivationResult> {
    let input: Element | null;
    try {
      input = await prepareLiveInput(text, requestId, generation);
    } catch (error) {
      const detail = errorMessage(error);
      return { ok: false, path: 'enter-key', detail,
        errorKey: (preserveExistingDraft || sendConfirmation !== 'heuristic') && detail === 'live editor contains different text'
          ? 'error.existing_draft'
          : sendConfirmation === 'single-activation' && detail === 'verified editor no longer contains the requested prompt'
            ? 'error.input_injection_failed' : undefined };
    }
    if (!input) return { ok: false, path: 'enter-key', detail: 'input disappeared' };
    lastActivatedInput = input;
    const sendButton = await retryLookup(
      () => querySendButton(input),
      SEND_BUTTON_TIMEOUT_MS,
      () => isActiveRequest(requestId, generation),
    );
    if (!isActiveRequest(requestId, generation)) return { ok: false, path: 'enter-key', detail: 'request cancelled' };
    if (sendConfirmation !== 'heuristic') {
      if (sendStarted()) return { ok: true, path: 'button-click' };
      if (queryInput() !== input || !inputTextMatches(input, text)) {
        return { ok: false, path: 'button-click', errorKey: 'error.send_unconfirmed' };
      }
      if (!sendButton) return { ok: false, path: 'button-click', errorKey: 'error.send_action_unavailable' };
      if (isDisabled(sendButton)) return { ok: false, path: 'button-click', errorKey: 'error.send_action_disabled' };
      if (sendConfirmation === 'single-activation') {
        if (isThinking()) return { ok: false, path: 'button-click', errorKey: 'error.response_in_progress' };
        // Ignore any orphan turns that appeared during lookup or editor insertion.
        // Capture the actual current page immediately before our own dispatch.
        responseBaselineEls = new Set(queryResponses());
        semanticResponseBaseline = captureSemanticResponseBaseline(querySemanticResponses(), extractResponseText);
        userMessageBaselineEls = new Set(queryUserMessages());
        matchingUserMessageBaselineCount = matchingPromptCount(Array.from(userMessageBaselineEls, userMessageText), text);
        sawMatchingUserMessage = false;
        matchingUserMessageElement = undefined;
        responseWaitStartedAt = Date.now();
      }
      reportRequestState('submission_pending', 'uncertain');
      sendDispatched = true;
      const ok = clickElement(sendButton);
      return { ok, path: 'button-click', detail: ok ? undefined : 'send control could not be activated' };
    }
    if (sendButton && !isDisabled(sendButton) && clickElement(sendButton)) {
      reportRequestState('submission_pending', 'uncertain');
      sendDispatched = true;
      return { ok: true, path: 'button-click' };
    }
    const ok = dispatchEnter(input);
    if (ok) {
      reportRequestState('submission_pending', 'uncertain');
      sendDispatched = true;
    }
    return { ok, path: 'enter-key', detail: ok ? undefined : 'Enter dispatch failed' };
  }

  async function prepareLiveInput(text: string, requestId: string | undefined, generation: number): Promise<Element | null> {
    if (!isActiveRequest(requestId, generation)) return null;
    const input = await retryLookup(
      queryInput,
      INPUT_TIMEOUT_MS,
      () => isActiveRequest(requestId, generation),
    );
    if (!input || !isActiveRequest(requestId, generation)) return null;
    if (inputTextMatches(input, text)) return input;
    if (readInputText(input).trim()) throw new Error('live editor contains different text');
    if (sendConfirmation === 'single-activation') {
      throw new Error('verified editor no longer contains the requested prompt');
    }
    if (!isActiveRequest(requestId, generation)) return null;
    await injectInput(input, text, () => isActiveRequest(requestId, generation));
    await Promise.resolve();
    if (!isActiveRequest(requestId, generation)) return null;
    assertInputLanded(input, text);
    return input;
  }

  function querySendButton(input: Element): Element | null {
    const container = input.closest?.('form, fieldset, [data-testid*="composer"], [class*="composer"], [class*="input-area"]');
    if (container) {
      const local = queryFirst(config.sendButtonSelectors, container, true, config.sendButtonFilter);
      if (local) return local;
    }
    return queryFirst(config.sendButtonSelectors, document, true, config.sendButtonFilter);
  }

  function queryUserMessages(): Element[] {
    const selectors = config.userMessageSelectors ?? [];
    return selectors.length
      ? distinctSemanticResponseTurns(Array.from(document.querySelectorAll(selectors.join(', '))))
      : [];
  }

  function userMessageText(element: Element): string {
    if (config.userMessageText) return config.userMessageText(element);
    return (element as HTMLElement).innerText || element.textContent || '';
  }

  function hasNewMatchingUserMessage(): boolean {
    if (sawMatchingUserMessage) {
      if (!anchorSemanticResponsesAfterMatchingUserMessage || matchingUserMessageElement?.isConnected) {
        return true;
      }
      // React may remount the confirmed user bubble. Reacquire the actual live element so
      // compareDocumentPosition keeps anchoring responses to the current conversation tree.
      sawMatchingUserMessage = false;
      matchingUserMessageElement = undefined;
    }
    const messages = queryUserMessages();
    if (userMessageTracking === 'semantic-count') {
      const matchingMessages = messages.filter((element) => (
        contentMatchesPrompt(userMessageText(element), activePromptText)
      ));
      sawMatchingUserMessage = matchingMessages.length > matchingUserMessageBaselineCount;
      if (sawMatchingUserMessage) {
        matchingUserMessageElement = matchingMessages[matchingMessages.length - 1];
      }
      return sawMatchingUserMessage;
    }
    matchingUserMessageElement = messages.find((element) => (
      !userMessageBaselineEls.has(element)
      && contentMatchesPrompt(userMessageText(element), activePromptText)
    ));
    sawMatchingUserMessage = Boolean(matchingUserMessageElement);
    return sawMatchingUserMessage;
  }

  function sendStarted(): boolean {
    if (!waitingForResponse) return true;
    if (submissionAccepted) return true;
    if (sendConfirmation === 'matching-user-message') {
      const accepted = hasNewMatchingUserMessage();
      if (accepted) {
        sawGenerationActivity = true;
        sendDispatched = true;
        reportRequestState('submission_accepted', 'submitted');
      }
      return accepted;
    }
    if (sendConfirmation === 'single-activation') {
      if (!sendDispatched) return false;
      const hasCurrentResponse = responseTracking === 'semantic-latest'
        ? Boolean(getLatestResponseText())
        : queryResponses().some((element) => !responseBaselineEls.has(element));
      const accepted = hasNewMatchingUserMessage() || hasCurrentResponse
        || (sendDispatched && !thinkingAtRequestStart && isCurrentTurnThinking());
      if (accepted) sawGenerationActivity = true;
      if (accepted) reportRequestState('submission_accepted', 'submitted');
      return accepted;
    }
    if (isCurrentTurnThinking()) {
      sawGenerationActivity = true;
      reportRequestState('submission_accepted', 'submitted');
      return true;
    }
    const hasCurrentResponse = responseTracking === 'semantic-latest'
      ? Boolean(getLatestResponseText())
      : queryResponses().some((element) => !responseBaselineEls.has(element));
    if (hasCurrentResponse) {
      sawGenerationActivity = true;
      reportRequestState('submission_accepted', 'submitted');
      return true;
    }
    const hasNewUserMessage = hasNewMatchingUserMessage();
    if (hasNewUserMessage) {
      sawGenerationActivity = true;
      reportRequestState('submission_accepted', 'submitted');
      return true;
    }
    const input = queryInput();
    const cleared = Boolean(input && !readInputText(input).trim());
    const confirmedByClear = cleared && clearedComposerConfirmsSend(
      lastActivatedInput,
      input,
      Boolean(config.requireSameComposerForClearConfirmation),
      hasNewUserMessage,
    );
    if (confirmedByClear) {
      sawGenerationActivity = true;
      reportRequestState('submission_accepted', 'submitted');
    }
    return confirmedByClear;
  }

  function isCurrentTurnThinking(): boolean {
    if (sendConfirmation === 'single-activation' && !sendDispatched) return false;
    return generationSignalBelongsToCurrentTurn(
      isThinking(),
      requireMatchingUserMessageForGenerationSignals,
      hasNewMatchingUserMessage(),
    );
  }

  function getLatestResponseText(): string | null {
    if (sendConfirmation === 'single-activation' && !sendDispatched) return null;
    const currentTurnConfirmed = !requireMatchingUserMessageForGenerationSignals
      || hasNewMatchingUserMessage();
    if (responseTracking === 'semantic-latest') {
      return currentSemanticResponseText(
        querySemanticResponses(),
        semanticResponseBaseline,
        extractResponseText,
        currentTurnConfirmed,
      );
    }
    if (!currentTurnConfirmed) return null;
    const responses = queryResponses();
    for (let index = responses.length - 1; index >= 0; index -= 1) {
      const response = responses[index];
      if (waitingForResponse && responseBaselineEls.has(response)) continue;
      const text = extractResponseText(response);
      if (text) return text;
    }
    return null;
  }

  function queryResponses(): Element[] {
    const candidates = Array.from(document.querySelectorAll(responseSelectors.join(', ')));
    return config.responseFilter ? candidates.filter(config.responseFilter) : candidates;
  }

  function querySemanticResponses(): Element[] {
    // A legacy selector can match historical replies while the current reply
    // uses newer markup. Do not let earlier matches hide a later fallback.
    const candidates = distinctSemanticResponseTurns(
      queryResponses(),
    );
    if (!anchorSemanticResponsesAfterMatchingUserMessage) return candidates;
    if (!matchingUserMessageElement) return [];
    return responsesFollowingAnchor<Element>(candidates, matchingUserMessageElement);
  }

  function captureFailureDiagnostics(reason: string): ProviderRequestDiagnostics {
    const currentText = getLatestResponseText();
    // Counts and lengths are intentionally the only page observations emitted
    // for a failed request. They help distinguish a selector miss from an empty
    // or still-streaming candidate without serializing provider content.
    return {
      responseCandidateCount: queryResponses().length,
      semanticResponseCandidateCount: responseTracking === 'semantic-latest'
        ? querySemanticResponses().length
        : undefined,
      currentResponseLength: currentText?.length ?? 0,
      generationObserved: sawGenerationActivity,
      failureCode: decodeError(reason)?.key ?? 'unstructured_provider_error',
    };
  }

  function extractResponseText(response: Element): string | null {
    if (config.prepareResponse && !config.prepareResponse(response)) return null;
    return extractResponseContent(response, responseContentRoot);
  }

  function observeResponses(): void {
    responseObserver = new MutationObserver(() => {
      // Claude/SPA composers mount several seconds after load; re-report the moment
      // login state flips so the card reaches "ready" without waiting for the 10s poll.
      reportStatus();
      if (waitingForResponse && sendDispatched) sendStarted();
      if (!waitingForResponse || (isCurrentTurnThinking() && !streamWhileThinking)) return;
      updateResponse();
    });
    responseObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function updateResponse(): void {
    const currentText = getLatestResponseText();
    if (!currentText || currentText === lastResponseText) return;
    sawGenerationActivity = true;
    reportRequestState('generating', 'submitted');
    lastResponseText = currentText;
    const now = Date.now();
    if (now - lastChunkTime >= chunkDebounce) {
      lastChunkTime = now;
      safeSendMessage({
        action: 'RESPONSE_CHUNK',
        provider,
        requestId: activeRequestId,
        workflowId: activeWorkflowId,
        payload: currentText,
      });
    }
    if (responseTimeout !== undefined) clearTimeout(responseTimeout);
    scheduleResponseTimeout(checkIfDone, doneDelay);
  }

  function startResponsePolling(): void {
    if (pollInterval !== undefined) return;
    const generation = responseGeneration;
    const timer = setInterval(() => {
      if (!isCurrentResponseGeneration(generation)) {
        clearInterval(timer);
        if (pollInterval === timer) pollInterval = undefined;
        return;
      }
      if (sendDispatched) sendStarted();
      const thinking = isCurrentTurnThinking();
      if (thinking) {
        sawGenerationActivity = true;
        if (!streamWhileThinking) return;
      }
      const currentText = getLatestResponseText();
      if (currentText) {
        updateResponse();
        return;
      }
      // Reading chunks during generation must not start the no-response timeout
      // while a slow provider still reports that it is working.
      if (thinking) return;
      // sawGenerationActivity 只代表「送出去了」（輸入框被清空也算），不代表真的產生過內容，
      // 所以這條路徑必須等滿寬限期才收尾，否則慢的模型會在送出後幾秒就被判定沒有回應。
      if (!sawGenerationActivity || responseTimeout !== undefined) return;
      if (Date.now() - responseWaitStartedAt < NO_RESPONSE_GRACE_MS) return;
      scheduleResponseTimeout(() => {
        if (isCurrentTurnThinking()) return;
        const finalText = getLatestResponseText();
        if (finalText) {
          lastResponseText = finalText;
          finishResponse();
          return;
        }
        // 報錯而非填佔位字串：假答案會被背景當成正常結果，餵進下一棒的 prompt。
        finishWithError(encodeError('error.no_response_text', { provider }));
      }, doneDelay, generation);
    }, 3000);
    pollInterval = timer;
  }

  function checkIfDone(generation = responseGeneration): void {
    if (!isCurrentResponseGeneration(generation)) return;
    if (isCurrentTurnThinking()) {
      if (checkDoneInterval === undefined) {
        const timer = setInterval(() => {
          if (!isCurrentResponseGeneration(generation)) return clearDoneCheck(timer);
          if (!isCurrentTurnThinking()) {
            clearDoneCheck(timer);
            scheduleResponseTimeout(checkIfDone, doneDelay, generation);
          }
        }, 1000);
        checkDoneInterval = timer;
      }
      return;
    }
    finishResponse();
  }

  function finishResponse(generation = responseGeneration): void {
    if (!isCurrentResponseGeneration(generation)) return;
    if (isCurrentTurnThinking()) {
      checkIfDone(generation);
      return;
    }
    // Must re-read before resetResponseState(): the baseline filter keys off waitingForResponse.
    const freshText = getLatestResponseText();
    if (config.prepareResponse && !freshText) {
      // A folded/remounted answer is not ready simply because an earlier
      // introductory chunk was cached. Wait for a complete fresh extraction.
      if (Date.now() - responseWaitStartedAt >= NO_RESPONSE_GRACE_MS) {
        finishWithError(encodeError('error.no_response_text', { provider }));
      } else {
        scheduleResponseTimeout(checkIfDone, doneDelay, generation);
      }
      return;
    }
    // A provider preparation hook declares the fresh answer complete. Cleanup
    // can remove status labels or hidden previews, making that answer shorter
    // than an earlier cached rendering without losing substantive content.
    const text = config.prepareResponse && freshText
      ? freshText : longerResponseText(lastResponseText, freshText);
    const requestId = activeRequestId;
    const workflowId = activeWorkflowId;
    if (requestId && workflowId) {
      recentCompletedRequest = { requestId, workflowId, text, completedAt: Date.now() };
      reportRequestState('response_complete', 'submitted');
    }
    resetResponseState();
    failedRequestTombstone = undefined;
    safeSendMessage({ action: 'RESPONSE_DONE', provider, requestId, workflowId, payload: text });
  }

  function finishWithError(reason: string, requestId = activeRequestId, workflowId = activeWorkflowId, generation = responseGeneration): void {
    if (!isActiveRequest(requestId, generation) || workflowId !== activeWorkflowId) return;
    const settlesActiveRequest = waitingForResponse
      && requestId === activeRequestId
      && workflowId === activeWorkflowId;
    const failedRequest = settlesActiveRequest && (requestId !== undefined || workflowId !== undefined)
      ? { requestId, workflowId, dispatched: sendDispatched, reason }
      : undefined;
    const failureState: ProviderRequestState = reason.includes('error.existing_draft')
      ? 'existing_draft'
      : sendDispatched ? 'uncertain_submission' : 'recoverable_failure';
    reportRequestState(
      failureState,
      sendDispatched ? 'uncertain' : 'not_submitted',
      captureFailureDiagnostics(reason),
    );
    resetResponseState();
    // Recovery arrives after RESPONSE_DONE has settled the background waiter. Keep only this
    // exact failed identity so its later scoped STOP can still click a provider stream that
    // outlived our local timeout. Starting any newer SEND clears the tombstone first.
    if (failedRequest) failedRequestTombstone = failedRequest;
    safeSendMessage({ action: 'RESPONSE_DONE', provider, requestId, workflowId, payload: `[Error: ${reason}]` });
  }

  function stopGeneration(requestId?: string, workflowId?: string): boolean {
    if (!shouldStopContentRequest(
      waitingForResponse,
      activeRequestId,
      activeWorkflowId,
      failedRequestTombstone?.requestId,
      failedRequestTombstone?.workflowId,
      requestId,
      workflowId,
    )) return false;
    const stoppedRequest = waitingForResponse
      ? { requestId: activeRequestId, workflowId: activeWorkflowId, dispatched: sendDispatched }
      : failedRequestTombstone;
    if (sendConfirmation === 'single-activation' && stoppedRequest?.dispatched === false) {
      // This request never activated Send. A visible Stop belongs to another turn.
      resetResponseState();
      failedRequestTombstone = undefined;
      return true;
    }
    const stopButton = queryFirst(
      config.stopButtonSelectors ?? [],
      document,
      true,
      config.stopButtonFilter,
    );
    const stopActivated = Boolean(stopButton && clickElement(stopButton));
    resetResponseState();
    failedRequestTombstone = sendConfirmation !== 'heuristic' && stoppedRequest?.dispatched
      ? stoppedRequest : undefined;
    if (failedRequestTombstone) {
      cancelledRequestCleanup = {
        ...failedRequestTombstone,
        generation: responseGeneration,
        deadline: Date.now() + CANCELLED_SEND_CLEANUP_TIMEOUT_MS,
        stopActivated,
      };
      pollCancelledRequestStop(cancelledRequestCleanup);
    }
    return true;
  }

  function pollCancelledRequestStop(candidate: CancelledRequestCleanup): void {
    if (cancelledRequestCleanup !== candidate) return;
    if (!isContextValid() || waitingForResponse || responseGeneration !== candidate.generation
      || failedRequestTombstone?.requestId !== candidate.requestId
      || failedRequestTombstone?.workflowId !== candidate.workflowId) {
      clearCancelledRequestCleanup();
      return;
    }
    const stopButton = queryFirst(config.stopButtonSelectors ?? [], document, true, config.stopButtonFilter);
    if (!stopButton && candidate.stopActivated) {
      failedRequestTombstone = undefined;
      clearCancelledRequestCleanup();
      return;
    }
    if (Date.now() >= candidate.deadline) {
      // Stop polling, but retain the exact identity for a later explicit scoped cleanup.
      clearCancelledRequestCleanup();
      return;
    }
    if (stopButton && !candidate.stopActivated) candidate.stopActivated = clickElement(stopButton);
    candidate.timer = window.setTimeout(() => pollCancelledRequestStop(candidate), INPUT_RETRY_MS);
  }

  function clearCancelledRequestCleanup(): void {
    if (cancelledRequestCleanup?.timer !== undefined) window.clearTimeout(cancelledRequestCleanup.timer);
    cancelledRequestCleanup = undefined;
  }

  function resetResponseState(): void {
    waitingForResponse = false;
    responseGeneration += 1;
    clearResponseTimers();
    clearCancelledRequestCleanup();
    responseBaselineEls.clear();
    semanticResponseBaseline = { count: 0, latestText: '' };
    userMessageBaselineEls.clear();
    matchingUserMessageBaselineCount = 0;
    sawMatchingUserMessage = false;
    matchingUserMessageElement = undefined;
    activeRequestId = undefined;
    activeWorkflowId = undefined;
    activePromptText = '';
    lastActivatedInput = undefined;
    sawGenerationActivity = false;
    sendDispatched = false;
    submissionAccepted = false;
    lastReportedRequestState = undefined;
  }

  function isActiveRequest(requestId?: string, generation = responseGeneration): boolean {
    return generation === responseGeneration && isActiveContentRequest(
      disposed,
      runtimeState,
      scope[marker],
      waitingForResponse,
      activeRequestId,
      requestId,
    );
  }

  function scheduleForRequest(callback: () => void, delay: number, requestId = activeRequestId, generation = responseGeneration): void {
    const timer = window.setTimeout(() => {
      sendTimeouts.delete(timer);
      if (isActiveRequest(requestId, generation)) callback();
    }, delay);
    sendTimeouts.add(timer);
  }

  function scheduleResponseTimeout(
    callback: (generation: number) => void,
    delay: number,
    generation = responseGeneration,
  ): void {
    if (responseTimeout !== undefined) clearTimeout(responseTimeout);
    const timer = setTimeout(() => {
      if (responseTimeout === timer) responseTimeout = undefined;
      if (isCurrentResponseGeneration(generation)) callback(generation);
    }, delay);
    responseTimeout = timer;
  }

  function isCurrentResponseGeneration(generation: number): boolean {
    return isActiveResponseGeneration(waitingForResponse, responseGeneration, generation);
  }

  function clearDoneCheck(timer = checkDoneInterval): void {
    if (timer !== undefined) clearInterval(timer);
    if (checkDoneInterval === timer) checkDoneInterval = undefined;
  }

  function clearResponseTimers(): void {
    if (responseTimeout !== undefined) clearTimeout(responseTimeout);
    if (pollInterval !== undefined) clearInterval(pollInterval);
    clearDoneCheck();
    responseTimeout = undefined;
    pollInterval = undefined;
    for (const timer of sendTimeouts) window.clearTimeout(timer);
    sendTimeouts.clear();
  }

  const runtimeListener = (message: ExtensionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    if (message.action === 'SEND_MESSAGE' && message.provider === provider) {
      const { text = '' } = (message.payload as { text?: string } | undefined) ?? {};
      const previousGeneration = responseGeneration;
      const sending = sendMessage(text, message.requestId, message.workflowId);
      const acknowledgedEarly = Boolean(config.acknowledgeOnRequestStart
        && responseGeneration !== previousGeneration
        && isActiveRequest(message.requestId, responseGeneration)
        && activeWorkflowId === message.workflowId);
      if (acknowledgedEarly) sendResponse({ ok: true });
      void sending
        .then(() => { if (!acknowledgedEarly) sendResponse({ ok: true }); })
        .catch((error) => {
          // finishWithError has already emitted a scoped RESPONSE_DONE. Keep
          // that completion authoritative: rejecting the command first makes
          // the worker discard its own provider error and show an unscoped
          // system message instead.
          const settledFailure = failedRequestTombstone;
          const failureAlreadyReported = Boolean(settledFailure
            && settledFailure.requestId === message.requestId
            && settledFailure.workflowId === message.workflowId);
          if (!acknowledgedEarly) sendResponse({ ok: false, error: errorMessage(error), ...(failureAlreadyReported ? { failureAlreadyReported: true } : {}) });
        });
      return !acknowledgedEarly;
    }
    if (message.action === 'CHECK_STATUS') {
      // A service worker can restart while this content script survives. Always answer its
      // explicit probe even when our locally observed status has not changed.
      reportStatus(true);
      sendResponse({ ok: true });
      return true;
    }
    if (message.action === 'QUERY_PROVIDER_REQUEST_STATE' && message.provider === provider) {
      const requestId = message.requestId;
      const workflowId = message.workflowId;
      if (!requestId || !workflowId) {
        sendResponse({ state: 'idle', submission: 'not_submitted' });
        return true;
      }
      if (waitingForResponse && requestId === activeRequestId && workflowId === activeWorkflowId) {
        const state: ProviderRequestState = lastReportedRequestState ?? (lastResponseText ? 'generating'
          : sendDispatched ? 'submission_pending' : 'prompt_inserting');
        sendResponse({ state, submission: submissionEvidenceForState(state) });
        return true;
      }
      if (recentCompletedRequest
        && recentCompletedRequest.requestId === requestId
        && recentCompletedRequest.workflowId === workflowId) {
        sendResponse({ state: 'response_complete', submission: 'submitted', response: recentCompletedRequest.text });
        return true;
      }
      if (failedRequestTombstone
        && failedRequestTombstone.requestId === requestId
        && failedRequestTombstone.workflowId === workflowId) {
        const submission = failedRequestTombstone.dispatched ? 'uncertain' : 'not_submitted';
        sendResponse({
          state: failedRequestTombstone.dispatched ? 'uncertain_submission' : 'recoverable_failure',
          submission,
          ...(failedRequestTombstone.reason ? { response: `[Error: ${failedRequestTombstone.reason}]` } : {}),
        });
        return true;
      }
      sendResponse({ state: 'idle', submission: 'not_submitted' });
      return true;
    }
    if (message.action === 'STOP_GENERATION' && (!message.provider || message.provider === provider)) {
      const stopped = stopGeneration(message.requestId, message.workflowId);
      sendResponse({ ok: stopped });
      return true;
    }
    return false;
  };

  runtimeState.dispose = cleanup;
  chrome.runtime.onMessage.addListener(runtimeListener);

  reportStatus(true);
  statusInterval = setInterval(() => reportStatus(true), 10_000);
  observeResponses();
}

async function retryLookup<T>(
  lookup: () => T | null | undefined,
  timeoutMs: number,
  shouldContinue: () => boolean = () => true,
): Promise<T | null> {
  const startedAt = Date.now();
  while (true) {
    if (!shouldContinue()) return null;
    const value = lookup();
    if (value) return value;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(INPUT_RETRY_MS, timeoutMs - elapsed)));
  }
}

function queryFirst(
  selectors: readonly string[],
  root: ParentNode = document,
  requireVisible = false,
  filter: (element: Element) => boolean = () => true,
): Element | null {
  return firstAcceptedCandidate(
    selectors,
    (selector) => Array.from(root.querySelectorAll(selector)),
    (candidate) => (!requireVisible || isVisible(candidate)) && filter(candidate),
  );
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function getInputText(input: Element): string {
  return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input.textContent ?? '';
}

function getExactInputText(input: Element): string {
  return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement
    ? input.value : (input as HTMLElement).innerText || input.textContent || '';
}

function composerTextMatches(input: Element, expected: string): boolean {
  const compact = (value: string) => value.replace(/\s+/g, '');
  return compact(getInputText(input)) === compact(expected);
}

function defaultInjectInput(input: Element, text: string): void {
  const element = input as HTMLElement;
  focusWithoutScroll(element);
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    const prototype = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  if (inserted && composerTextMatches(input, text)) return;

  element.replaceChildren();
  for (const line of text.split('\n')) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line || '\u00A0';
    element.appendChild(paragraph);
  }
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

function clickElement(element: Element): boolean {
  if (isDisabled(element)) return false;
  const target = element as HTMLElement;
  try {
    focusWithoutScroll(target);
    target.click();
    return true;
  } catch {
    return false;
  }
}

function isDisabled(element: Element): boolean {
  const target = element as HTMLElement & { disabled?: boolean };
  return Boolean(target.disabled || target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true' || target.getAttribute('data-disabled') === 'true');
}

function dispatchEnter(input: Element): boolean {
  focusWithoutScroll(input as HTMLElement);
  const target = document.activeElement ?? input;
  const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  try {
    target.dispatchEvent(new KeyboardEvent('keydown', options));
    target.dispatchEvent(new KeyboardEvent('keypress', options));
    target.dispatchEvent(new KeyboardEvent('keyup', options));
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
