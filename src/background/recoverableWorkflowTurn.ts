import type { AIProvider } from '../shared/types';
import {
  ProviderRequestError,
  runRecoverableWorkflowStep,
  type RecoverableWorkflowDependencies,
} from './roundtableRecovery';

// Re-exported for deterministic adapter-independent workflow tests. Provider
// adapters never import this; they report ordinary failures to the worker.
export { ProviderRequestError };

export interface RecoverableWorkflowTurn {
  key: string;
  provider: AIProvider;
  labelKey: string;
  role?: string;
  round?: number;
}

export interface CheckpointedTurnDependencies extends RecoverableWorkflowDependencies {
  contributionForTurn: (turnKey: string) => { text: string } | undefined;
  onTurnStarted: (turn: RecoverableWorkflowTurn) => Promise<void> | void;
  onTurnCompleted: (turn: RecoverableWorkflowTurn, response: string, requestId?: string) => Promise<void> | void;
}

/**
 * Runs one serial workflow turn with the same recovery contract used by the
 * Roundtable.  This keeps a provider/role/request association intact for all
 * serial modes, and makes a restart reuse only a checkpointed contribution for
 * that exact turn.
 */
export async function runCheckpointedRecoverableTurn(
  turn: RecoverableWorkflowTurn,
  prompt: string,
  workflowId: string,
  dependencies: CheckpointedTurnDependencies,
): Promise<string> {
  const restored = dependencies.contributionForTurn(turn.key);
  if (restored) return restored.text;

  await dependencies.onTurnStarted(turn);
  let latestRequestId: string | undefined;
  const response = await runRecoverableWorkflowStep(turn.provider, prompt, workflowId, turn.labelKey, {
    ...dependencies,
    onAttempt: async (provider, requestId, attempt) => {
      latestRequestId = requestId;
      await dependencies.onAttempt?.(provider, requestId, attempt);
    },
  });
  await dependencies.onTurnCompleted(turn, response, latestRequestId);
  return response;
}
