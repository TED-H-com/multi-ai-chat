import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureSemanticResponseBaseline,
  currentSemanticResponseText,
  isActiveResponseGeneration,
  responsesFollowingAnchor,
} from '../src/content/responseTracking.ts';

const readText = (response: { text: string }) => response.text || null;

test('a newly appended Grok assistant turn is selected', () => {
  const previous = { text: 'previous answer' };
  const baseline = captureSemanticResponseBaseline([previous], readText);

  assert.equal(
    currentSemanticResponseText([previous, { text: 'new answer' }], baseline, readText),
    'new answer',
  );
});

test('a recycled Grok assistant element is selected when its text changes', () => {
  const recycled = { text: 'previous answer' };
  const baseline = captureSemanticResponseBaseline([recycled], readText);
  recycled.text = 'streaming answer';

  assert.equal(currentSemanticResponseText([recycled], baseline, readText), 'streaming answer');
});

test('an appended empty assistant shell never falls back to the previous answer', () => {
  const previous = { text: 'previous answer' };
  const baseline = captureSemanticResponseBaseline([previous], readText);

  assert.equal(
    currentSemanticResponseText([previous, { text: '' }], baseline, readText),
    null,
  );
});

test('an orphaned failed stream cannot masquerade as a recycled Retry response', () => {
  const recycled = { text: 'partial failed answer' };
  const baseline = captureSemanticResponseBaseline([recycled], readText);
  recycled.text = 'complete failed answer';

  assert.equal(currentSemanticResponseText([recycled], baseline, readText, false), null);
  assert.equal(
    currentSemanticResponseText([recycled], baseline, readText, true),
    'complete failed answer',
  );
});

test('a late-appended orphan response is ignored until Retry has a matching user turn', () => {
  const failedTurn = { text: 'partial failed answer' };
  const baseline = captureSemanticResponseBaseline([failedTurn], readText);
  const lateOrphan = { text: 'late completion from failed attempt' };

  assert.equal(
    currentSemanticResponseText([failedTurn, lateOrphan], baseline, readText, false),
    null,
  );
});

test('anchored tracking excludes the user bubble and its Markdown descendants', () => {
  const user = { position: 0 };
  const promptMarkdown = { position: 4 | 16 };
  const olderAssistant = { position: 2 };
  const answer = { position: 4 };
  const detached = { position: 1 | 4 };
  const anchor = { compareDocumentPosition: (node: { position: number }) => node.position };
  assert.deepEqual(responsesFollowingAnchor([olderAssistant, user, promptMarkdown, answer, detached], anchor), [answer]);
});

test('anchored Grok tracking excludes an old assistant before the confirmed Retry user turn', () => {
  interface PositionedResponse {
    order: number;
    text: string;
    disconnected?: boolean;
  }
  const retryUser = {
    order: 2,
    compareDocumentPosition(response: PositionedResponse) {
      if (response.disconnected) return 5;
      return response.order > this.order ? 4 : 2;
    },
  };
  const oldAssistant = { order: 1, text: 'old stream keeps mutating' };
  const retryAssistant = { order: 3, text: 'answer for Retry' };
  const disconnectedAssistant = { order: 4, text: 'different document', disconnected: true };
  const anchored = responsesFollowingAnchor(
    [oldAssistant, retryAssistant, disconnectedAssistant],
    retryUser,
  );
  const anchoredBaseline = captureSemanticResponseBaseline<PositionedResponse>([], readText);

  assert.deepEqual(anchored, [retryAssistant]);
  assert.equal(
    currentSemanticResponseText(anchored, anchoredBaseline, readText, true),
    'answer for Retry',
  );
});

test('a pure React remount of the old Grok answer is not mistaken for this attempt', () => {
  const baseline = captureSemanticResponseBaseline([{ text: 'previous answer' }], readText);
  const remountedPreviousTurn = { text: 'previous answer' };

  assert.equal(currentSemanticResponseText([remountedPreviousTurn], baseline, readText), null);
});

test('an appended repeated answer still counts as a new Grok turn', () => {
  const previous = { text: 'same answer' };
  const baseline = captureSemanticResponseBaseline([previous], readText);

  assert.equal(
    currentSemanticResponseText([previous, { text: 'same answer' }], baseline, readText),
    'same answer',
  );
});

test('a completion callback from the failed attempt cannot finish its retry', () => {
  const failedAttemptGeneration = 7;
  const retryGeneration = 9;

  assert.equal(isActiveResponseGeneration(true, retryGeneration, failedAttemptGeneration), false);
  assert.equal(isActiveResponseGeneration(true, retryGeneration, retryGeneration), true);
  assert.equal(isActiveResponseGeneration(false, retryGeneration, retryGeneration), false);
});
