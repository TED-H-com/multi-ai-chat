import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkpointTurnCompleted,
  checkpointTurnFailed,
  checkpointTurnStarted,
  checkpointTurnState,
  contributionForTurn,
  createWorkflowCheckpoint,
  normalizeWorkflowCheckpoint,
} from '../src/shared/workflowCheckpoint.ts';

function start() {
  return createWorkflowCheckpoint({
    workflowId: '123e4567-e89b-42d3-a456-426614174000',
    sessionId: 'session', clientId: 'client', mode: 'roundtable', text: 'English task',
    roles: { first: 'chatgpt', second: 'gemini', third: 'grok', fourth: 'meta' },
    recovery: { enabled: true, policy: 'safe' },
  }, 1);
}

test('checkpoint records a turn lifecycle without storing provider browser data', () => {
  let checkpoint = start();
  checkpoint = checkpointTurnStarted(checkpoint, {
    turnKey: 'roundtable:1:0', provider: 'gemini', requestId: 'request', state: 'prompt_inserting', submission: 'not_submitted', attempt: 1,
  }, 2);
  checkpoint = checkpointTurnState(checkpoint, 'request', 'submission_accepted', 'submitted', 3);
  checkpoint = checkpointTurnCompleted(checkpoint, {
    turnKey: 'roundtable:1:0', provider: 'gemini', requestId: 'request', round: 1,
    text: 'English answer', status: 'complete', completedAt: 4,
  }, 4);
  assert.equal(checkpoint.current, undefined);
  assert.equal(contributionForTurn(checkpoint, 'roundtable:1:0')?.text, 'English answer');
  assert.equal(JSON.stringify(checkpoint).includes('cookie'), false);
});

test('checkpoint retains failure category and evidence for safe resumption', () => {
  let checkpoint = start();
  checkpoint = checkpointTurnStarted(checkpoint, {
    turnKey: 'roundtable:1:1', provider: 'gemini', requestId: 'request', state: 'submission_pending', submission: 'uncertain', attempt: 1,
  }, 2);
  checkpoint = checkpointTurnFailed(checkpoint, {
    turnKey: 'roundtable:1:1', provider: 'gemini', kind: 'submission', submission: 'uncertain', attempt: 1, at: 3,
  }, 3);
  assert.equal(checkpoint.current?.submission, 'uncertain');
  assert.deepEqual(checkpoint.failures[0], {
    turnKey: 'roundtable:1:1', provider: 'gemini', kind: 'submission', submission: 'uncertain', attempt: 1, at: 3,
  });
});

test('checkpoint validation rejects incomplete persisted data', () => {
  assert.equal(normalizeWorkflowCheckpoint({ workflowId: 'x' }), undefined);
  const malformed = start();
  malformed.current = {
    turnKey: 'roundtable:1:0', provider: 'gemini', requestId: 'request', state: 'not_a_state', submission: 'not_submitted', attempt: 1, updatedAt: 2,
  };
  assert.equal(normalizeWorkflowCheckpoint(malformed), undefined);
  assert.equal(normalizeWorkflowCheckpoint(start())?.workflowId, '123e4567-e89b-42d3-a456-426614174000');
});
