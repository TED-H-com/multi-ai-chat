import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseAutonomousRecoveryAction,
  normalizeAutonomousRecoverySettings,
  preserveStrongestSubmissionEvidence,
  recoveryBackoffMs,
} from '../src/shared/autonomousRecovery.ts';

test('Safe Automatic retries only a proven-unsent transient insertion failure', () => {
  assert.equal(chooseAutonomousRecoveryAction({
    settings: { enabled: true, policy: 'safe' },
    failureKind: 'prompt_insertion',
    reason: 'i18n:{"key":"error.input_not_found"}',
    submission: 'not_submitted',
    attempts: 1,
  }), 'retry');
  assert.equal(chooseAutonomousRecoveryAction({
    settings: { enabled: true, policy: 'safe' },
    failureKind: 'prompt_insertion',
    reason: 'i18n:{"key":"error.input_not_found"}',
    submission: 'not_submitted',
    attempts: 2,
  }), 'skip');
});

test('existing drafts and ambiguous submissions are never automatically replayed', () => {
  for (const input of [
    { failureKind: 'prompt_insertion' as const, reason: 'i18n:{"key":"error.existing_draft"}', submission: 'not_submitted' as const },
    { failureKind: 'submission' as const, reason: 'i18n:{"key":"error.send_unconfirmed"}', submission: 'uncertain' as const },
    { failureKind: 'response_timeout' as const, reason: 'i18n:{"key":"error.timeout"}', submission: 'submitted' as const },
  ]) {
    assert.notEqual(chooseAutonomousRecoveryAction({
      settings: { enabled: true, policy: 'safe' }, attempts: 1, ...input,
    }), 'retry');
  }
});

test('Strict Completion pauses and Best-Effort records unavailable work', () => {
  const common = {
    failureKind: 'authentication' as const,
    reason: 'i18n:{"key":"error.not_ready"}',
    submission: 'not_submitted' as const,
    attempts: 1,
  };
  assert.equal(chooseAutonomousRecoveryAction({ settings: { enabled: true, policy: 'strict' }, ...common }), 'manual');
  assert.equal(chooseAutonomousRecoveryAction({ settings: { enabled: true, policy: 'best-effort' }, ...common }), 'skip');
  assert.equal(chooseAutonomousRecoveryAction({ settings: { enabled: false, policy: 'safe' }, ...common }), 'manual');
});

test('settings normalization and retry delays remain bounded', () => {
  assert.deepEqual(normalizeAutonomousRecoverySettings(undefined), { enabled: false, policy: 'safe' });
  assert.deepEqual(normalizeAutonomousRecoverySettings({ policy: 'best-effort' }), { enabled: false, policy: 'best-effort' });
  assert.deepEqual(normalizeAutonomousRecoverySettings({ enabled: false, policy: 'strict' }), { enabled: false, policy: 'strict' });
  assert.equal(recoveryBackoffMs(1), 500);
  assert.equal(recoveryBackoffMs(2), 1_000);
  assert.equal(recoveryBackoffMs(100), 1_000);
});

test('restart reconciliation never weakens submission evidence', () => {
  assert.equal(preserveStrongestSubmissionEvidence('submitted', 'not_submitted'), 'submitted');
  assert.equal(preserveStrongestSubmissionEvidence('uncertain', 'not_submitted'), 'uncertain');
  assert.equal(preserveStrongestSubmissionEvidence('not_submitted', 'submitted'), 'submitted');
});
