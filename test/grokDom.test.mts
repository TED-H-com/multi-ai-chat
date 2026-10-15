import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GROK_INPUT_SELECTORS,
  GROK_REQUIRE_MATCHING_USER_MESSAGE_FOR_GENERATION_SIGNALS,
  GROK_REQUIRE_SAME_COMPOSER_FOR_CLEAR_CONFIRMATION,
  isGrokComposerInput,
  isGrokGenerationActive,
  isGrokStopControl,
  isGrokSendControl,
  grokSessionReady,
  updateGrokTextControl,
} from '../src/content/grokDom.ts';
import { firstAcceptedCandidate } from '../src/content/elementSelection.ts';
import { decideLoginStatus } from '../src/content/loginStatusStability.ts';
import {
  clearedComposerConfirmsSend,
  generationSignalBelongsToCurrentTurn,
} from '../src/content/sendConfirmation.ts';

interface FakeInput {
  ariaLabel: string | null;
  inChatInput: boolean;
  visible: boolean;
  testId: string | null;
  formHasComposer: boolean;
  legacyProseMirror: boolean;
  getAttribute(name: string): string | null;
  closest(selectors: string): unknown;
  matches(selectors: string): boolean;
}

function fakeInput(options: Partial<FakeInput> = {}): FakeInput {
  const input: FakeInput = {
    ariaLabel: null,
    inChatInput: false,
    visible: true,
    testId: null,
    formHasComposer: false,
    legacyProseMirror: false,
    getAttribute: (name) => name === 'aria-label'
      ? input.ariaLabel
      : name === 'data-testid' ? input.testId : null,
    closest: (selector) => {
      if (selector === '[data-testid="chat-input"]') return input.inChatInput ? {} : null;
      if (selector === 'form' && input.formHasComposer) return { querySelector: () => ({}) };
      return null;
    },
    matches: (selector) => selector === '.ProseMirror[contenteditable="true"]' && input.legacyProseMirror,
  };
  return Object.assign(input, options);
}

test('Grok input lookup accepts the live Ask Grok textarea and skips hidden editors', () => {
  const hiddenEditor = fakeInput({ inChatInput: true, visible: false });
  const liveTextarea = fakeInput({ ariaLabel: 'Ask Grok anything' });
  const candidates = new Map<string, readonly FakeInput[]>([
    [GROK_INPUT_SELECTORS[0], [hiddenEditor]],
    [GROK_INPUT_SELECTORS[1], [liveTextarea]],
  ]);

  const selected = firstAcceptedCandidate(
    GROK_INPUT_SELECTORS,
    (selector) => candidates.get(selector) ?? [],
    (candidate) => candidate.visible && isGrokComposerInput(candidate),
  );

  assert.strictEqual(selected, liveTextarea);
  assert.equal(isGrokComposerInput(fakeInput({ legacyProseMirror: true })), true);
});

test('generic Stop controls outside the Grok composer are ignored', () => {
  assert.equal(isGrokStopControl(fakeInput()), false);
  assert.equal(isGrokStopControl(fakeInput({ formHasComposer: true })), true);
  assert.equal(isGrokStopControl(fakeInput({ testId: 'chat-stop-button' })), true);
});

test('Grok submit lookup excludes unrelated form submit controls', () => {
  assert.equal(isGrokSendControl(fakeInput()), false);
  assert.equal(isGrokSendControl(fakeInput({ formHasComposer: true })), true);
  assert.equal(isGrokSendControl(fakeInput({ testId: 'chat-submit' })), true);
});

test('Grok composer lookup excludes disabled and read-only inputs', () => {
  assert.equal(isGrokComposerInput(Object.assign(fakeInput({ ariaLabel: 'Ask Grok anything' }), { disabled: true })), false);
  assert.equal(isGrokComposerInput(Object.assign(fakeInput({ ariaLabel: 'Ask Grok anything' }), { readOnly: true })), false);
});

test('unrecognized Grok readiness remains unknown while actual generation stays ready', () => {
  assert.equal(grokSessionReady(false, false), null);
  assert.equal(grokSessionReady(false, true), true);
});

test('an empty replacement composer does not confirm a Grok Retry send', () => {
  assert.equal(GROK_REQUIRE_SAME_COMPOSER_FOR_CLEAR_CONFIRMATION, true);
  assert.equal(clearedComposerConfirmsSend(
    { editor: 'detached' },
    { editor: 'replacement' },
    GROK_REQUIRE_SAME_COMPOSER_FOR_CLEAR_CONFIRMATION,
    false,
  ), false);
});

test('native Grok textarea injection sets value and dispatches input', () => {
  const textarea = { value: '' };
  const events: string[] = [];

  updateGrokTextControl(
    textarea,
    'retry prompt',
    (value) => { textarea.value = value; },
    (value) => { events.push(`input:${value}`); },
  );

  assert.equal(textarea.value, 'retry prompt');
  assert.deepEqual(events, ['input:retry prompt']);
});

test('hidden stop controls and historical Thinking text do not keep Grok active', () => {
  const hiddenStop = { visible: false, streaming: false, thinkingTexts: [] as string[] };
  const historicalThinking = { visible: true, streaming: false, thinkingTexts: ['Thinking...'] };
  const latestComplete = { visible: true, streaming: false, thinkingTexts: ['Thought for 4s'] };

  assert.equal(isGrokGenerationActive(
    [hiddenStop],
    [historicalThinking, latestComplete],
    (element) => element.visible,
    (turn) => turn,
  ), false);
});

test('a visible stop control or streaming latest assistant turn keeps Grok active', () => {
  const visible = (element: { visible: boolean }) => element.visible;
  const signals = (turn: { streaming: boolean; thinkingTexts: string[] }) => turn;
  const complete = { visible: true, streaming: false, thinkingTexts: ['Thought for 1s'] };
  const streaming = { visible: true, streaming: true, thinkingTexts: [] as string[] };

  assert.equal(isGrokGenerationActive([{ ...complete }], [complete], visible, signals), true);
  assert.equal(isGrokGenerationActive([], [complete, streaming], visible, signals), true);
});

test('a visible orphan Stop cannot confirm Retry before its matching user turn appears', () => {
  const visibleStopSignal = isGrokGenerationActive(
    [{ visible: true, streaming: false, thinkingTexts: [] as string[] }],
    [],
    (element) => element.visible,
    (turn) => turn,
  );

  assert.equal(GROK_REQUIRE_MATCHING_USER_MESSAGE_FOR_GENERATION_SIGNALS, true);
  assert.equal(generationSignalBelongsToCurrentTurn(
    visibleStopSignal,
    GROK_REQUIRE_MATCHING_USER_MESSAGE_FOR_GENERATION_SIGNALS,
    false,
  ), false);
  assert.equal(generationSignalBelongsToCurrentTurn(
    visibleStopSignal,
    GROK_REQUIRE_MATCHING_USER_MESSAGE_FOR_GENERATION_SIGNALS,
    true,
  ), true);
});

test('Grok stays connected through a composer to stop-only to composer transition', () => {
  const connected = decideLoginStatus({}, {
    ready: grokSessionReady(true, false),
    explicitlyLoggedOut: false,
    now: 0,
    lossDelayMs: 2500,
  });
  const generatingAfterGrace = decideLoginStatus(connected.state, {
    ready: grokSessionReady(false, true),
    explicitlyLoggedOut: false,
    now: 5000,
    lossDelayMs: 2500,
  });
  const composerReturned = decideLoginStatus(generatingAfterGrace.state, {
    ready: grokSessionReady(true, false),
    explicitlyLoggedOut: false,
    now: 6000,
    lossDelayMs: 2500,
  });

  assert.equal(connected.report, true);
  assert.equal(generatingAfterGrace.report, undefined);
  assert.deepEqual(generatingAfterGrace.state, { reported: true });
  assert.equal(composerReturned.report, undefined);
});
