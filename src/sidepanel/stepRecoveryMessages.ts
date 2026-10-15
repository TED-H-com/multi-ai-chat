import type { AIProvider, ProviderFailureKind, StepRecoveryRequest, WorkflowStatusPayload } from '../shared/types';

export interface StepRecoveryMessageEnvelope {
  provider?: unknown;
  requestId?: unknown;
  workflowId?: unknown;
  payload?: unknown;
}

export interface StepRecoveryMessageContext {
  clientId: string;
  sessionId: string;
  activeWorkflowId?: string;
  currentRecoveryId?: string;
  ignoredWorkflowIds: ReadonlySet<string>;
  completedWorkflowIds: ReadonlySet<string>;
  handledRecoveryIds: ReadonlySet<string>;
}

export function acceptStepRecoveryMessage(
  message: StepRecoveryMessageEnvelope,
  context: StepRecoveryMessageContext,
): StepRecoveryRequest | undefined {
  if (!isStepRecoveryRequest(message.payload)) return undefined;
  const recovery = message.payload;
  if (recovery.clientId !== context.clientId
    || recovery.sessionId !== context.sessionId
    || recovery.workflowId !== message.workflowId
    || recovery.failedRequestId !== message.requestId
    || recovery.provider !== message.provider
    || context.ignoredWorkflowIds.has(recovery.workflowId)
    || context.completedWorkflowIds.has(recovery.workflowId)
    || context.handledRecoveryIds.has(recovery.recoveryId)
    || context.currentRecoveryId === recovery.recoveryId
    || (context.activeWorkflowId !== undefined && context.activeWorkflowId !== recovery.workflowId)) {
    return undefined;
  }
  return recovery;
}

export function acceptWorkflowResponse(
  workflowId: string | undefined,
  activeWorkflowId: string | undefined,
  ignoredWorkflowIds: ReadonlySet<string>,
): boolean {
  return Boolean(workflowId && workflowId === activeWorkflowId && !ignoredWorkflowIds.has(workflowId));
}

export function activeWorkflowAfterStatus(
  activeWorkflowId: string | undefined,
  status: Pick<WorkflowStatusPayload, 'cancelled' | 'done' | 'workflowId'>,
): string | undefined {
  if (status.done && status.cancelled && status.workflowId === activeWorkflowId) return undefined;
  return activeWorkflowId;
}

export function shouldClearStepRecovery(
  recovery: StepRecoveryRequest | null,
  status: Pick<WorkflowStatusPayload, 'done' | 'workflowId'>,
): boolean {
  return Boolean(status.done && recovery && recovery.workflowId === status.workflowId);
}

function isStepRecoveryRequest(value: unknown): value is StepRecoveryRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<StepRecoveryRequest>;
  return typeof request.recoveryId === 'string'
    && typeof request.workflowId === 'string'
    && typeof request.sessionId === 'string'
    && typeof request.clientId === 'string'
    && isProvider(request.provider)
    && typeof request.failedRequestId === 'string'
    && typeof request.reason === 'string'
    && (request.failureKind === undefined || isProviderFailureKind(request.failureKind));
}

function isProviderFailureKind(value: unknown): value is ProviderFailureKind {
  return value === 'prompt_insertion'
    || value === 'submission'
    || value === 'response_timeout'
    || value === 'response_extraction'
    || value === 'authentication'
    || value === 'quota_or_rate_limit'
    || value === 'navigation'
    || value === 'unexpected';
}

function isProvider(value: unknown): value is AIProvider {
  return value === 'chatgpt' || value === 'claude' || value === 'gemini' || value === 'grok' || value === 'meta';
}
