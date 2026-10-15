import type {
  AIProvider,
  ChatMode,
  CodingRoles,
  ConsultRoles,
  DebateRoles,
  ModeRoles,
  ProviderFailureKind,
  RoundtableRoles,
} from './types';
import type { AutonomousRecoverySettings, SubmissionEvidence } from './autonomousRecovery';

export const WORKFLOW_CHECKPOINT_STORAGE_KEY = 'multiAiWorkflowCheckpoint';
export const WORKFLOW_CHECKPOINT_VERSION = 1;

export type WorkflowContributionStatus = 'complete' | 'unavailable';

export interface WorkflowContributionCheckpoint {
  turnKey: string;
  provider: AIProvider;
  requestId?: string;
  round?: number;
  role?: string;
  text: string;
  status: WorkflowContributionStatus;
  completedAt: number;
}

export interface WorkflowRequestCheckpoint {
  turnKey: string;
  provider: AIProvider;
  requestId: string;
  submission: SubmissionEvidence;
  state: string;
  attempt: number;
  documentId?: string;
  updatedAt: number;
}

export interface WorkflowFailureCheckpoint {
  turnKey: string;
  provider: AIProvider;
  kind: ProviderFailureKind;
  submission: SubmissionEvidence;
  attempt: number;
  at: number;
}

export interface WorkflowCheckpoint {
  version: number;
  workflowId: string;
  sessionId: string;
  clientId: string;
  mode: ChatMode;
  text: string;
  context?: string;
  roles?: DebateRoles | ConsultRoles | CodingRoles | RoundtableRoles;
  targets?: AIProvider[];
  recovery: AutonomousRecoverySettings;
  contributions: WorkflowContributionCheckpoint[];
  current?: WorkflowRequestCheckpoint;
  failures: WorkflowFailureCheckpoint[];
  createdAt: number;
  updatedAt: number;
  lastCheckpointAt: number;
}

export interface WorkflowCheckpointStart {
  workflowId: string;
  sessionId: string;
  clientId: string;
  mode: ChatMode;
  text: string;
  context?: string;
  roles?: ModeRoles;
  targets?: AIProvider[];
  recovery: AutonomousRecoverySettings;
}

export function createWorkflowCheckpoint(start: WorkflowCheckpointStart, now = Date.now()): WorkflowCheckpoint {
  return {
    version: WORKFLOW_CHECKPOINT_VERSION,
    workflowId: start.workflowId,
    sessionId: start.sessionId,
    clientId: start.clientId,
    mode: start.mode,
    text: start.text,
    context: start.context,
    roles: start.roles as WorkflowCheckpoint['roles'],
    targets: start.targets ? [...start.targets] : undefined,
    recovery: { ...start.recovery },
    contributions: [],
    failures: [],
    createdAt: now,
    updatedAt: now,
    lastCheckpointAt: now,
  };
}

export function normalizeWorkflowCheckpoint(value: unknown): WorkflowCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<WorkflowCheckpoint>;
  if (candidate.version !== WORKFLOW_CHECKPOINT_VERSION
    || typeof candidate.workflowId !== 'string'
    || typeof candidate.sessionId !== 'string'
    || typeof candidate.clientId !== 'string'
    || !isChatMode(candidate.mode)
    || typeof candidate.text !== 'string'
    || !Array.isArray(candidate.contributions)
    || !Array.isArray(candidate.failures)
    || !candidate.recovery
    || !Number.isFinite(candidate.createdAt)
    || !Number.isFinite(candidate.updatedAt)
    || !Number.isFinite(candidate.lastCheckpointAt)
    || !candidate.contributions.every(isContribution)
    || !candidate.failures.every(isFailure)
    || (candidate.current !== undefined && !isCurrent(candidate.current))) return undefined;
  return {
    ...candidate,
    recovery: normalizeRecovery(candidate.recovery),
  } as WorkflowCheckpoint;
}

export function checkpointTurnStarted(
  checkpoint: WorkflowCheckpoint,
  current: Omit<WorkflowRequestCheckpoint, 'updatedAt'>,
  now = Date.now(),
): WorkflowCheckpoint {
  return touch(checkpoint, { current: { ...current, updatedAt: now } }, now);
}

export function checkpointTurnState(
  checkpoint: WorkflowCheckpoint,
  requestId: string,
  state: string,
  submission: SubmissionEvidence,
  now = Date.now(),
): WorkflowCheckpoint {
  if (!checkpoint.current || checkpoint.current.requestId !== requestId) return checkpoint;
  return touch(checkpoint, { current: { ...checkpoint.current, state, submission, updatedAt: now } }, now);
}

export function checkpointTurnFailed(
  checkpoint: WorkflowCheckpoint,
  failure: WorkflowFailureCheckpoint,
  now = Date.now(),
): WorkflowCheckpoint {
  return touch(checkpoint, {
    current: checkpoint.current && checkpoint.current.turnKey === failure.turnKey
      ? { ...checkpoint.current, state: 'recoverable_failure', submission: failure.submission, updatedAt: now }
      : checkpoint.current,
    failures: [...checkpoint.failures, failure].slice(-50),
  }, now);
}

export function checkpointTurnCompleted(
  checkpoint: WorkflowCheckpoint,
  contribution: WorkflowContributionCheckpoint,
  now = Date.now(),
): WorkflowCheckpoint {
  const withoutCurrent = checkpoint.current?.turnKey === contribution.turnKey ? undefined : checkpoint.current;
  const existing = checkpoint.contributions.findIndex((item) => item.turnKey === contribution.turnKey);
  const contributions = existing < 0
    ? [...checkpoint.contributions, contribution]
    : checkpoint.contributions.map((item, index) => index === existing ? contribution : item);
  return touch(checkpoint, { current: withoutCurrent, contributions }, now);
}

export function checkpointForClient(checkpoint: WorkflowCheckpoint, clientId: string, now = Date.now()): WorkflowCheckpoint {
  return touch(checkpoint, { clientId }, now);
}

export function contributionForTurn(checkpoint: WorkflowCheckpoint | undefined, turnKey: string): WorkflowContributionCheckpoint | undefined {
  return checkpoint?.contributions.find((item) => item.turnKey === turnKey);
}

function touch(checkpoint: WorkflowCheckpoint, patch: Partial<WorkflowCheckpoint>, now: number): WorkflowCheckpoint {
  return { ...checkpoint, ...patch, updatedAt: now, lastCheckpointAt: now };
}

function isChatMode(value: unknown): value is ChatMode {
  return value === 'free' || value === 'debate' || value === 'consult' || value === 'coding' || value === 'roundtable';
}

function isProvider(value: unknown): value is AIProvider {
  return value === 'chatgpt' || value === 'claude' || value === 'gemini' || value === 'grok' || value === 'meta';
}

function isSubmissionEvidence(value: unknown): value is SubmissionEvidence {
  return value === 'not_submitted' || value === 'uncertain' || value === 'submitted';
}

function isContribution(value: unknown): value is WorkflowContributionCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkflowContributionCheckpoint>;
  return typeof candidate.turnKey === 'string'
    && isProvider(candidate.provider)
    && typeof candidate.text === 'string'
    && (candidate.status === 'complete' || candidate.status === 'unavailable')
    && Number.isFinite(candidate.completedAt)
    && (candidate.requestId === undefined || typeof candidate.requestId === 'string')
    && (candidate.round === undefined || Number.isInteger(candidate.round))
    && (candidate.role === undefined || typeof candidate.role === 'string');
}

function isFailure(value: unknown): value is WorkflowFailureCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkflowFailureCheckpoint>;
  return typeof candidate.turnKey === 'string'
    && isProvider(candidate.provider)
    && isSubmissionEvidence(candidate.submission)
    && Number.isInteger(candidate.attempt)
    && Number.isFinite(candidate.at)
    && (candidate.kind === 'prompt_insertion'
      || candidate.kind === 'submission'
      || candidate.kind === 'response_timeout'
      || candidate.kind === 'response_extraction'
      || candidate.kind === 'authentication'
      || candidate.kind === 'quota_or_rate_limit'
      || candidate.kind === 'navigation'
      || candidate.kind === 'unexpected');
}

function isCurrent(value: unknown): value is WorkflowRequestCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkflowRequestCheckpoint>;
  return typeof candidate.turnKey === 'string'
    && isProvider(candidate.provider)
    && typeof candidate.requestId === 'string'
    && isSubmissionEvidence(candidate.submission)
    && isCheckpointProviderState(candidate.state)
    && Number.isInteger(candidate.attempt)
    && Number.isFinite(candidate.updatedAt)
    && (candidate.documentId === undefined || typeof candidate.documentId === 'string');
}

function normalizeRecovery(value: unknown): AutonomousRecoverySettings {
  const candidate = value as Partial<AutonomousRecoverySettings>;
  return {
    enabled: candidate.enabled === true,
    policy: candidate.policy === 'strict' || candidate.policy === 'best-effort' ? candidate.policy : 'safe',
  };
}

function isCheckpointProviderState(value: unknown): boolean {
  return value === 'not_ready'
    || value === 'idle'
    || value === 'existing_draft'
    || value === 'prompt_inserting'
    || value === 'prompt_inserted'
    || value === 'submission_pending'
    || value === 'submission_accepted'
    || value === 'generating'
    || value === 'response_complete'
    || value === 'rate_limited'
    || value === 'temporarily_unavailable'
    || value === 'recoverable_failure'
    || value === 'uncertain_submission'
    || value === 'terminal_failure';
}
