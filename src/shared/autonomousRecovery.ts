import type { ProviderFailureKind } from './types';

export type AutonomousRecoveryPolicy = 'safe' | 'strict' | 'best-effort';

export interface AutonomousRecoverySettings {
  enabled: boolean;
  policy: AutonomousRecoveryPolicy;
}

export type SubmissionEvidence = 'not_submitted' | 'uncertain' | 'submitted';

export type AutonomousRecoveryAction = 'retry' | 'skip' | 'manual';

export const DEFAULT_AUTONOMOUS_RECOVERY: AutonomousRecoverySettings = {
  enabled: false,
  policy: 'safe',
};

export const MAX_SAFE_RECOVERY_ATTEMPTS = 2;

export function normalizeAutonomousRecoverySettings(value: unknown): AutonomousRecoverySettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_AUTONOMOUS_RECOVERY };
  const candidate = value as Partial<AutonomousRecoverySettings>;
  return {
    // A missing flag can come from an older saved setting. Preserve the
    // conservative default instead of unexpectedly enabling automation.
    enabled: candidate.enabled === true,
    policy: candidate.policy === 'strict' || candidate.policy === 'best-effort' ? candidate.policy : 'safe',
  };
}

/**
 * Chooses only actions that are safe without inspecting a provider tab. A
 * retry is permitted exclusively when we have proof that Send was never
 * activated. Uncertain or accepted submissions are never replayed.
 */
export function chooseAutonomousRecoveryAction(input: {
  settings: AutonomousRecoverySettings;
  failureKind: ProviderFailureKind;
  reason: string;
  submission: SubmissionEvidence;
  attempts: number;
}): AutonomousRecoveryAction {
  const { settings, failureKind, reason, submission, attempts } = input;
  if (!settings.enabled) return 'manual';

  const key = errorKey(reason);
  const retryableInsertion = failureKind === 'prompt_insertion'
    && key !== 'error.existing_draft'
    && submission === 'not_submitted'
    && attempts < MAX_SAFE_RECOVERY_ATTEMPTS;
  if (retryableInsertion) return 'retry';

  // A user draft, an accepted/ambiguous submission, authentication loss, and
  // quotas must not be retried by the extension. Best-effort records the seat
  // as unavailable; Safe does the same after its bounded safe attempts. Strict
  // deliberately pauses so a required contribution is never implied.
  if (settings.policy === 'strict') return 'manual';
  return 'skip';
}

function errorKey(reason: string): string | undefined {
  const match = /"key"\s*:\s*"([^"]+)"/.exec(reason);
  return match?.[1];
}

export function recoveryBackoffMs(attempt: number): number {
  // 500 ms then 1 s. This stays short enough for a live extension event and
  // bounded enough that a broken provider cannot hold a workflow indefinitely.
  return Math.min(1_000, 500 * (2 ** Math.max(0, attempt - 1)));
}

/**
 * A restart may observe less than the worker recorded before it was reclaimed.
 * Preserve the strongest evidence so an accepted or ambiguous provider action
 * can never become safe to replay merely because a content script remounted.
 */
export function preserveStrongestSubmissionEvidence(
  recorded: SubmissionEvidence,
  observed: SubmissionEvidence,
): SubmissionEvidence {
  const rank: Record<SubmissionEvidence, number> = {
    not_submitted: 0,
    uncertain: 1,
    submitted: 2,
  };
  return rank[observed] > rank[recorded] ? observed : recorded;
}
