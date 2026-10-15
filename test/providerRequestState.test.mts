import assert from 'node:assert/strict';
import test from 'node:test';
import { isProviderRequestState, shouldAcceptProviderState, submissionEvidenceForState } from '../src/shared/providerRequestState.ts';

test('provider state rejects stale backwards progress but accepts terminal outcomes', () => {
  assert.equal(shouldAcceptProviderState('generating', 'prompt_inserted'), false);
  assert.equal(shouldAcceptProviderState('generating', 'response_complete'), true);
  assert.equal(shouldAcceptProviderState('generating', 'recoverable_failure'), true);
});

test('submission evidence never promotes a draft or insertion to submitted', () => {
  assert.equal(submissionEvidenceForState('existing_draft'), 'not_submitted');
  assert.equal(submissionEvidenceForState('submission_pending'), 'uncertain');
  assert.equal(submissionEvidenceForState('submission_accepted'), 'submitted');
});

test('only known provider state names enter the durable workflow protocol', () => {
  assert.equal(isProviderRequestState('submission_accepted'), true);
  assert.equal(isProviderRequestState('made_up_state'), false);
  assert.equal(isProviderRequestState({}), false);
});
