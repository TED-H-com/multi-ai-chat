import type { AIProvider } from './types';
import type { SubmissionEvidence } from './autonomousRecovery';

export type ProviderRequestState =
  | 'not_ready'
  | 'idle'
  | 'existing_draft'
  | 'prompt_inserting'
  | 'prompt_inserted'
  | 'submission_pending'
  | 'submission_accepted'
  | 'generating'
  | 'response_complete'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'recoverable_failure'
  | 'uncertain_submission'
  | 'terminal_failure';

// Safe provider-page observations attached only to lifecycle events.  These
// fields deliberately describe DOM state rather than any prompt, response, or
// account data, so a live failure can be diagnosed without retaining content.
export interface ProviderRequestDiagnostics {
  responseCandidateCount?: number;
  semanticResponseCandidateCount?: number;
  currentResponseLength?: number;
  generationObserved?: boolean;
  failureCode?: string;
}

export interface ProviderRequestStatePayload {
  provider: AIProvider;
  requestId: string;
  workflowId: string;
  state: ProviderRequestState;
  submission: SubmissionEvidence;
  diagnostics?: ProviderRequestDiagnostics;
}

const RANK: Record<ProviderRequestState, number> = {
  not_ready: 0,
  idle: 0,
  existing_draft: 1,
  prompt_inserting: 2,
  prompt_inserted: 3,
  submission_pending: 4,
  uncertain_submission: 5,
  submission_accepted: 6,
  generating: 7,
  response_complete: 8,
  rate_limited: 8,
  temporarily_unavailable: 8,
  recoverable_failure: 8,
  terminal_failure: 9,
};

export function isProviderRequestState(value: unknown): value is ProviderRequestState {
  return typeof value === 'string' && value in RANK;
}

export function submissionEvidenceForState(state: ProviderRequestState): SubmissionEvidence {
  if (state === 'submission_accepted' || state === 'generating' || state === 'response_complete') return 'submitted';
  if (state === 'submission_pending' || state === 'uncertain_submission') return 'uncertain';
  return 'not_submitted';
}

/** Reject stale backwards state messages from a remounted provider document. */
export function shouldAcceptProviderState(current: ProviderRequestState | undefined, next: ProviderRequestState): boolean {
  if (!current) return true;
  if (next === 'recoverable_failure' || next === 'terminal_failure' || next === 'existing_draft') return true;
  return RANK[next] >= RANK[current];
}
