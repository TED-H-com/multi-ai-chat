import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertContentScriptAccepted } from '../src/background/messageDelivery.ts';
import { shouldStopActiveRequest } from '../src/shared/requestScope.ts';
import {
  activeCancellationTarget,
  createWorkflowCancellation,
  createWorkflowScope,
  isValidWorkflowId,
  WorkflowIdRegistry,
  WorkflowLifecycleRegistry,
} from '../src/shared/workflowScope.ts';
import { assertCurrentWorkflow, WorkflowStartGate } from '../src/background/workflowStartGate.ts';
import {
  acceptStepRecoveryMessage,
  acceptWorkflowResponse,
  activeWorkflowAfterStatus,
  shouldClearStepRecovery,
} from '../src/sidepanel/stepRecoveryMessages.ts';
import {
  ProviderRequestError,
  runRoundtableWorkflow,
  SKIP_RESPONSE,
  STEP_RECOVERY_DECISION_TIMEOUT_MS,
  StepRecoveryCoordinator,
  StepRecoveryReplayCoordinator,
  transferStepRecoveryOwnership,
  isStepRecoveryDecision,
  type RoundtableWorkflowDependencies,
} from '../src/background/roundtableRecovery.ts';
import type {
  AIProvider,
  RoundtableRoles,
  StepRecoveryAction,
  StepRecoveryDecision,
  StepRecoveryRequest,
} from '../src/shared/types.ts';

const roles: RoundtableRoles = {
  first: 'claude',
  second: 'gemini',
  third: 'grok',
  fourth: 'chatgpt',
};

test('Meta occupies one roundtable seat and can retry its failed turn', async () => {
  const harness = createHarness({ decisions: ['retry'], failAttempts: new Set([1]) });
  const history = await runRoundtableWorkflow('question', { ...roles, first: 'meta' }, 'workflow-meta', harness.dependencies);
  assert.equal(history.length, 20);
  assert.equal(harness.sends.length, 21);
  assert.equal(harness.roles[0].provider, 'meta');
  assert.equal(harness.roles[1].provider, 'meta');
  assert.equal(harness.roles.filter((entry) => entry.provider === 'meta').length, 6);
});

test('Meta skip does not leak its error into later roundtable prompts', async () => {
  const harness = createHarness({ decisions: ['skip'], failAttempts: new Set([1]), rawError: 'meta quota' });
  const history = await runRoundtableWorkflow('question', { ...roles, first: 'meta' }, 'workflow-meta-skip', harness.dependencies);
  assert.equal(history.length, 20);
  assert.equal(history[0].text, SKIP_RESPONSE);
  assert.equal(history[0].name, 'meta');
  assert.doesNotMatch(JSON.stringify(history), /meta quota/);
  assert.doesNotMatch(harness.sends[1].prompt, /meta quota/);
  assert.deepEqual(harness.resets, [{ provider: 'meta', requestId: 'request-1', workflowId: 'workflow-meta-skip' }]);
});

test('Meta cancel resets only the failed Meta turn', async () => {
  const harness = createHarness({ decisions: ['cancel'], failAttempts: new Set([1]) });
  await assert.rejects(
    runRoundtableWorkflow('question', { ...roles, first: 'meta' }, 'workflow-meta-cancel', harness.dependencies),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].provider, 'meta');
  assert.deepEqual(harness.resets, [{ provider: 'meta', requestId: 'request-1', workflowId: 'workflow-meta-cancel' }]);
  assert.deepEqual(harness.cancelled, ['workflow-meta-cancel']);
});

test('Meta recovery requests reach the side panel and accept retry, skip and cancel decisions', () => {
  const request: StepRecoveryRequest = {
    recoveryId: 'recovery-meta', workflowId: 'workflow-meta', sessionId: 'session', clientId: 'client',
    provider: 'meta', failedRequestId: 'request-meta', reason: 'quota',
  };
  assert.equal(acceptStepRecoveryMessage({
    provider: 'meta', workflowId: request.workflowId, requestId: request.failedRequestId, payload: request,
  }, {
    clientId: 'client', sessionId: 'session', activeWorkflowId: request.workflowId,
    ignoredWorkflowIds: new Set(), completedWorkflowIds: new Set(), handledRecoveryIds: new Set(),
  }), request);
  for (const action of ['retry', 'skip', 'cancel']) {
    assert.equal(isStepRecoveryDecision({ ...request, action }), true);
  }
});

test('Roundtable can skip a failed first turn and still completes all 20 logical turns', async () => {
  const rawError = '[Error: provider rate limited]';
  const harness = createHarness({ decisions: ['skip'], failAttempts: new Set([1]), rawError });
  const history = await runRoundtableWorkflow('question', roles, 'workflow-1', harness.dependencies);

  assert.equal(history.length, 20);
  assert.equal(history[0].text, SKIP_RESPONSE);
  assert.equal(harness.sends.length, 20);
  assert.equal(harness.statuses.length, 20);
  assert.equal(harness.roles.length, 20);
  assert.deepEqual(harness.resets, [{ provider: 'claude', requestId: 'request-1', workflowId: 'workflow-1' }]);
  assert.match(harness.sends[1].prompt, /\(no response — skipped\)/);
  assert.doesNotMatch(harness.sends[1].prompt, /provider rate limited/);
  assert.doesNotMatch(JSON.stringify(history), /provider rate limited/);
});

test('Roundtable retries the same prompt with a fresh request id and role assignment', async () => {
  const harness = createHarness({ decisions: ['retry'], failAttempts: new Set([1]) });
  const history = await runRoundtableWorkflow('question', roles, 'workflow-2', harness.dependencies);

  assert.equal(history.length, 20);
  assert.equal(harness.sends.length, 21);
  assert.equal(harness.sends[0].prompt, harness.sends[1].prompt);
  assert.notEqual(harness.sends[0].requestId, harness.sends[1].requestId);
  assert.deepEqual(harness.roles.slice(0, 2), [
    { provider: 'claude', labelKey: 'round.1', requestId: 'request-1' },
    { provider: 'claude', labelKey: 'round.1', requestId: 'request-2' },
  ]);
  assert.deepEqual(harness.resets, [{ provider: 'claude', requestId: 'request-1', workflowId: 'workflow-2' }]);
  assert.equal(history[0].text, 'answer-request-2');
  assert.deepEqual(harness.events.slice(0, 8), [
    'status:1:claude',
    'role:request-1',
    'send:request-1',
    'recovery:request-1',
    'decision:retry',
    'reset:request-1',
    'role:request-2',
    'send:request-2',
  ]);
});

for (const failedAttempt of [10, 20]) {
  test(`Roundtable can skip failed logical turn ${failedAttempt} without leaking its error`, async () => {
    const harness = createHarness({ decisions: ['skip'], failAttempts: new Set([failedAttempt]), rawError: 'quota exhausted' });
    const history = await runRoundtableWorkflow('question', roles, `workflow-skip-${failedAttempt}`, harness.dependencies);
    assert.equal(history.length, 20);
    assert.equal(history[failedAttempt - 1].text, SKIP_RESPONSE);
    assert.doesNotMatch(JSON.stringify(history), /quota exhausted/);
    assert.equal(harness.sends.length, 20);
  });
}

test('Roundtable cancellation resets the failed request and never sends the next turn', async () => {
  const harness = createHarness({ decisions: ['cancel'], failAttempts: new Set([1]) });

  await assert.rejects(
    runRoundtableWorkflow('question', roles, 'workflow-3', harness.dependencies),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(harness.sends.length, 1);
  assert.deepEqual(harness.resets, [{ provider: 'claude', requestId: 'request-1', workflowId: 'workflow-3' }]);
  assert.deepEqual(harness.cancelled, ['workflow-3']);
});

test('internal implementation errors remain terminal instead of opening recovery', async () => {
  const harness = createHarness({ decisions: ['skip'], failAttempts: new Set() });
  harness.dependencies.sendAndWait = async () => {
    throw new TypeError('programming bug');
  };

  await assert.rejects(runRoundtableWorkflow('question', roles, 'workflow-4', harness.dependencies), /programming bug/);
  assert.equal(harness.recoveryRequests.length, 0);
  assert.equal(harness.resets.length, 0);
});

test('recovery decisions require the full identity tuple and are atomically consumed', async () => {
  const coordinator = new StepRecoveryCoordinator(() => 'recovery-1');
  let published: StepRecoveryRequest | undefined;
  const decisionPromise = coordinator.waitForDecision(recoveryRequest(), (request) => { published = request; });
  assert.ok(published);
  for (const malformed of [undefined, null, {}, { action: 'skip' }, { ...published, action: 'invalid' }]) {
    assert.equal(coordinator.resolve(malformed), false);
  }

  const valid: StepRecoveryDecision = { ...published, action: 'skip' };
  const mismatches: Partial<StepRecoveryDecision>[] = [
    { recoveryId: 'old-recovery' },
    { workflowId: 'other-workflow' },
    { sessionId: 'other-session' },
    { clientId: 'other-client' },
    { provider: 'grok' },
    { failedRequestId: 'other-request' },
  ];
  for (const mismatch of mismatches) assert.equal(coordinator.resolve({ ...valid, ...mismatch }), false);
  assert.equal(coordinator.current()?.recoveryId, 'recovery-1');
  assert.equal(coordinator.resolve(valid), true);
  assert.equal(coordinator.resolve({ ...valid, action: 'retry' }), false);
  assert.equal(await decisionPromise, 'skip');
  assert.equal(coordinator.current(), undefined);
});

test('recovery notification failures and decision timeouts clear coordinator state', async () => {
  assert.ok(STEP_RECOVERY_DECISION_TIMEOUT_MS < 300_000);
  const notifyFailure = new StepRecoveryCoordinator(() => 'notify-failure', 50);
  const failed = notifyFailure.waitForDecision(recoveryRequest(), () => { throw new Error('listener failed'); });
  await assert.rejects(failed, /listener failed/);
  assert.equal(notifyFailure.current(), undefined);

  const timeout = new StepRecoveryCoordinator(() => 'timeout', 5);
  const expired = timeout.waitForDecision(recoveryRequest(), () => {});
  await assert.rejects(expired, /timed out/);
  assert.equal(timeout.current(), undefined);
  assert.equal(timeout.resolve({ recoveryId: 'timeout', ...recoveryRequest(), action: 'retry' }), false);
});

test('Retry waits for scoped provider reset before assigning or sending the next request', async () => {
  const harness = createHarness({ decisions: ['retry'], failAttempts: new Set([1]) });
  let finishReset: (() => void) | undefined;
  const resetGate = new Promise<void>((resolve) => { finishReset = resolve; });
  harness.dependencies.resetProvider = async (provider, requestId, workflowId) => {
    harness.events.push(`reset-start:${requestId}`);
    await resetGate;
    harness.resets.push({ provider, requestId, workflowId });
    harness.events.push(`reset-done:${requestId}`);
  };

  const workflow = runRoundtableWorkflow('question', roles, 'workflow-ordered', harness.dependencies);
  while (!harness.events.includes('reset-start:request-1')) await Promise.resolve();
  assert.equal(harness.events.includes('role:request-2'), false);
  assert.equal(harness.events.includes('send:request-2'), false);
  finishReset?.();
  await workflow;
  assert.ok(harness.events.indexOf('reset-done:request-1') < harness.events.indexOf('role:request-2'));
  assert.ok(harness.events.indexOf('role:request-2') < harness.events.indexOf('send:request-2'));
});

test('a recovery decision timeout resets the failed provider request before terminating', async () => {
  const harness = createHarness({ decisions: [], failAttempts: new Set([1]) });
  harness.dependencies.requestRecovery = async () => {
    throw new Error('decision expired');
  };
  await assert.rejects(runRoundtableWorkflow('question', roles, 'workflow-expired', harness.dependencies), /decision expired/);
  assert.deepEqual(harness.resets, [{ provider: 'claude', requestId: 'request-1', workflowId: 'workflow-expired' }]);
  assert.equal(harness.sends.length, 1);
});

test('abort, new-workflow supersession, and final cleanup reject pending recovery', async () => {
  let sequence = 0;
  const coordinator = new StepRecoveryCoordinator(() => `recovery-${++sequence}`);
  const first = coordinator.waitForDecision(recoveryRequest(), () => {});
  assert.equal(coordinator.cancel('wrong-workflow'), false);
  assert.equal(coordinator.cancel('workflow'), true);
  await assert.rejects(first, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(coordinator.current(), undefined);

  const superseded = coordinator.waitForDecision(recoveryRequest(), () => {});
  const current = coordinator.waitForDecision({ ...recoveryRequest(), workflowId: 'new-workflow' }, () => {});
  await assert.rejects(superseded, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(coordinator.current()?.workflowId, 'new-workflow');
  assert.equal(coordinator.cancel('new-workflow'), true);
  await assert.rejects(current, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
});

test('side-panel rebind rotates recovery identity so actions from the old client stay stale', async () => {
  let sequence = 0;
  const coordinator = new StepRecoveryCoordinator(() => `recovery-${++sequence}`);
  let original: StepRecoveryRequest | undefined;
  const result = coordinator.waitForDecision(recoveryRequest(), (request) => { original = request; });
  assert.ok(original);
  const rebound = coordinator.rebindClient('workflow', 'session', 'new-client');
  assert.ok(rebound);
  assert.notEqual(rebound.recoveryId, original.recoveryId);
  assert.equal(coordinator.resolve({ ...original, action: 'retry' }), false);
  assert.equal(coordinator.resolve({ ...rebound, action: 'retry' }), true);
  assert.equal(await result, 'retry');
});

test('a rebound recovery keeps its original deadline and cannot remain pending forever', async () => {
  let sequence = 0;
  const coordinator = new StepRecoveryCoordinator(() => `recovery-${++sequence}`, 5);
  const result = coordinator.waitForDecision(recoveryRequest(), () => {});
  assert.ok(coordinator.rebindClient('workflow', 'session', 'new-client'));
  await assert.rejects(result, /timed out/);
  assert.equal(coordinator.current(), undefined);
});

test('recovery timeout records whether a side panel rendered the matching controls', async () => {
  const unavailable = new StepRecoveryCoordinator(() => 'unavailable', 5);
  const unavailableDecision = unavailable.waitForDecision(
    recoveryRequest(),
    () => {},
    (_request, presented) => new Error(presented ? 'controls were shown' : 'controls unavailable'),
  );
  await assert.rejects(unavailableDecision, /controls unavailable/);

  const displayed = new StepRecoveryCoordinator(() => 'displayed', 5);
  let request: StepRecoveryRequest | undefined;
  const displayedDecision = displayed.waitForDecision(
    recoveryRequest(),
    (candidate) => { request = candidate; },
    (_request, presented) => new Error(presented ? 'controls were shown' : 'controls unavailable'),
  );
  assert.ok(request);
  assert.equal(displayed.markPresented({ ...request, reason: 'different diagnostic text is allowed' }), true);
  assert.equal(displayed.markPresented({ ...request, clientId: 'stale-client' }), false);
  await assert.rejects(displayedDecision, /controls were shown/);
});

test('a side-panel remount requires a receipt for the rebound recovery', async () => {
  let sequence = 0;
  const coordinator = new StepRecoveryCoordinator(() => `recovery-${++sequence}`, 5);
  let original: StepRecoveryRequest | undefined;
  const decision = coordinator.waitForDecision(
    recoveryRequest(),
    (request) => { original = request; },
    (_request, presented) => new Error(presented ? 'old receipt leaked' : 'rebound controls unavailable'),
  );
  assert.ok(original);
  assert.equal(coordinator.markPresented(original), true);
  const rebound = coordinator.rebindClient('workflow', 'session', 'new-client');
  assert.ok(rebound);
  await assert.rejects(decision, /rebound controls unavailable/);
});

test('content-script rejection fails fast while successful or absent acknowledgements remain accepted', () => {
  assert.throws(() => assertContentScriptAccepted({ ok: false, error: 'already responding' }), /already responding/);
  assert.throws(() => assertContentScriptAccepted({ ok: false }), /rejected the message/);
  assert.doesNotThrow(() => assertContentScriptAccepted({ ok: true }));
  assert.doesNotThrow(() => assertContentScriptAccepted(undefined));
});

test('scoped stop cannot terminate a newer request while unscoped user cancellation still can', () => {
  assert.equal(shouldStopActiveRequest('new-request', 'new-workflow', 'old-request', 'old-workflow'), false);
  assert.equal(shouldStopActiveRequest('new-request', 'new-workflow', 'new-request', 'old-workflow'), false);
  assert.equal(shouldStopActiveRequest('new-request', 'new-workflow', 'new-request', 'new-workflow'), true);
  assert.equal(shouldStopActiveRequest('new-request', 'new-workflow', undefined, undefined), true);
});

test('workflow starts are serialized even while the previous start awaits cleanup', async () => {
  const gate = new WorkflowStartGate();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = gate.run(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
    return 'first';
  });
  const second = gate.run(async () => {
    events.push('second:start');
    events.push('second:end');
    return 'second';
  });
  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  releaseFirst?.();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('an immediate scoped cancel prevents a registered workflow from starting or sending', async () => {
  const workflowId = '123e4567-e89b-42d3-a456-426614174000';
  const sendScope = createWorkflowScope('session', 'client', () => workflowId);
  const cancellation = createWorkflowCancellation('session', 'client', sendScope.workflowId);
  assert.deepEqual(cancellation, sendScope);
  assert.equal(createWorkflowCancellation('session', 'client', undefined), undefined);
  const lifecycle = new WorkflowLifecycleRegistry();
  const gate = new WorkflowStartGate();
  let activeWorkflowId: string | undefined;
  let providerSends = 0;
  assert.equal(lifecycle.register(sendScope), true);
  assert.deepEqual(lifecycle.requestCancellation(cancellation), sendScope);
  try {
    await assert.rejects(gate.run(async () => {
      lifecycle.assertCanStart(workflowId);
      activeWorkflowId = workflowId;
      providerSends += 1;
    }), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  } finally {
    if (activeWorkflowId === workflowId) activeWorkflowId = undefined;
    lifecycle.finish(workflowId);
  }
  assert.equal(providerSends, 0);
  assert.equal(activeWorkflowId, undefined);
  assert.equal(lifecycle.current(workflowId), undefined);
});

test('workflow ids reject malformed values and duplicate ownership claims', () => {
  const workflowId = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(isValidWorkflowId(workflowId), true);
  for (const malformed of [undefined, '', 'workflow-1', '123e4567-e89b-12d3-a456-426614174000']) {
    assert.equal(isValidWorkflowId(malformed), false);
  }
  const registry = new WorkflowIdRegistry();
  assert.equal(registry.claim(workflowId), true);
  assert.equal(registry.claim(workflowId), false);
  assert.equal(registry.claim('not-a-uuid'), false);
});

test('a stale cancellation can never target the newer active workflow', () => {
  assert.equal(activeCancellationTarget('workflow-b', 'workflow-c'), undefined);
  assert.equal(activeCancellationTarget('workflow-c', 'workflow-c'), 'workflow-c');
});

test('recovery client rebind updates the registered scope used by exact cancellation', () => {
  const workflowId = '123e4567-e89b-42d3-a456-426614174000';
  const original = createWorkflowScope('session', 'old-client', () => workflowId);
  const lifecycle = new WorkflowLifecycleRegistry();
  assert.equal(lifecycle.register(original), true);
  const rebound = lifecycle.rebind(workflowId, 'session', 'new-client');
  assert.deepEqual(rebound, { ...original, clientId: 'new-client' });
  assert.deepEqual(lifecycle.requestCancellation(rebound), rebound);
  assert.equal(lifecycle.rebind('other-workflow', 'session', 'new-client'), undefined);
  assert.equal(lifecycle.rebind(workflowId, 'other-session', 'new-client'), undefined);
});

test('recovery ownership rotates before the old client is revoked and only then reaches the new client', async () => {
  const previous: StepRecoveryRequest = { recoveryId: 'recovery-old', ...recoveryRequest() };
  const rebound: StepRecoveryRequest = { ...previous, recoveryId: 'recovery-new', clientId: 'new-client' };
  const events: string[] = [];
  let releaseRevocation: (() => void) | undefined;
  const revocationGate = new Promise<void>((resolve) => { releaseRevocation = resolve; });
  const transfer = transferStepRecoveryOwnership(
    previous,
    rebound.clientId,
    () => {
      events.push('rotate:new-client');
      return rebound;
    },
    async (owner) => {
      assert.equal(owner.clientId, 'client');
      events.push('revoke:old-client:start');
      await revocationGate;
      events.push('revoke:old-client:done');
    },
    (candidate) => candidate.recoveryId === rebound.recoveryId,
  );
  await Promise.resolve();
  assert.deepEqual(events, ['rotate:new-client', 'revoke:old-client:start']);
  releaseRevocation?.();
  const request = await transfer;
  if (request) events.push(`broadcast:${request.clientId}`);
  assert.deepEqual(events, [
    'rotate:new-client',
    'revoke:old-client:start',
    'revoke:old-client:done',
    'broadcast:new-client',
  ]);
});

test('a later ownership transfer invalidates an earlier transfer before it can publish', async () => {
  const original: StepRecoveryRequest = { recoveryId: 'recovery-a', ...recoveryRequest() };
  const ownerB: StepRecoveryRequest = { ...original, recoveryId: 'recovery-b', clientId: 'client-b' };
  const ownerC: StepRecoveryRequest = { ...original, recoveryId: 'recovery-c', clientId: 'client-c' };
  let currentRecoveryId = original.recoveryId;
  let releaseA: (() => void) | undefined;
  const revokeA = new Promise<void>((resolve) => { releaseA = resolve; });
  const transferToB = transferStepRecoveryOwnership(
    original,
    ownerB.clientId,
    () => {
      currentRecoveryId = ownerB.recoveryId;
      return ownerB;
    },
    async () => { await revokeA; },
    (candidate) => candidate.recoveryId === currentRecoveryId,
  );
  await Promise.resolve();
  const transferToC = transferStepRecoveryOwnership(
    ownerB,
    ownerC.clientId,
    () => {
      currentRecoveryId = ownerC.recoveryId;
      return ownerC;
    },
    async () => {},
    (candidate) => candidate.recoveryId === currentRecoveryId,
  );
  assert.deepEqual(await transferToC, ownerC);
  releaseA?.();
  assert.equal(await transferToB, undefined);
});

test('duplicate replay for a new owner cannot publish until revocation completes', async () => {
  const original: StepRecoveryRequest = { recoveryId: 'recovery-a', ...recoveryRequest() };
  const ownerB: StepRecoveryRequest = { ...original, recoveryId: 'recovery-b', clientId: 'client-b' };
  const replay = new StepRecoveryReplayCoordinator();
  const published: string[] = [];
  let current = original;
  let releaseRevocation: (() => void) | undefined;
  const revocationGate = new Promise<void>((resolve) => { releaseRevocation = resolve; });

  const first = replay.replay(async () => transferStepRecoveryOwnership(
    current,
    ownerB.clientId,
    () => {
      current = ownerB;
      return ownerB;
    },
    async () => { await revocationGate; },
    (candidate) => candidate.recoveryId === current.recoveryId,
  ), (request) => { published.push(request.recoveryId); });
  await Promise.resolve();
  const duplicate = replay.replay(async () => current, (request) => { published.push(request.recoveryId); });
  await Promise.resolve();
  assert.deepEqual(published, []);
  releaseRevocation?.();
  assert.deepEqual(await Promise.all([first, duplicate]), [true, true]);
  assert.deepEqual(published, ['recovery-b', 'recovery-b']);
});

test('a revoked live panel cannot reclaim a recovery its UI has already tombstoned', () => {
  const workflowId = '123e4567-e89b-42d3-a456-426614174000';
  const ownerA = 'client';
  const ownerB = 'client-b';
  const lifecycle = new WorkflowLifecycleRegistry();
  assert.equal(lifecycle.register({ workflowId, sessionId: 'session', clientId: ownerA }), true);
  assert.equal(lifecycle.canOwnRecovery(workflowId, ownerA), true);
  lifecycle.revokeRecoveryOwner(workflowId, ownerA);
  assert.equal(lifecycle.canOwnRecovery(workflowId, ownerA), false);
  assert.equal(lifecycle.canOwnRecovery(workflowId, ownerB), true);
  assert.deepEqual(lifecycle.rebind(workflowId, 'session', ownerB), { workflowId, sessionId: 'session', clientId: ownerB });
  if (lifecycle.canOwnRecovery(workflowId, ownerA)) lifecycle.rebind(workflowId, 'session', ownerA);
  assert.equal(lifecycle.current(workflowId)?.clientId, ownerB);

  const replayToA: StepRecoveryRequest = { recoveryId: 'recovery-returned-to-a', ...recoveryRequest(), workflowId };
  assert.equal(acceptStepRecoveryMessage({
    provider: replayToA.provider,
    requestId: replayToA.failedRequestId,
    workflowId,
    payload: replayToA,
  }, {
    clientId: ownerA,
    sessionId: replayToA.sessionId,
    activeWorkflowId: undefined,
    ignoredWorkflowIds: new Set([workflowId]),
    completedWorkflowIds: new Set([workflowId]),
    handledRecoveryIds: new Set(),
  }), undefined);
  lifecycle.finish(workflowId);
  assert.equal(lifecycle.canOwnRecovery(workflowId, ownerA), true);
});

test('a superseded workflow cannot emit status after a newer workflow becomes active', async () => {
  const gate = new WorkflowStartGate();
  const events: string[] = [];
  let activeWorkflowId: string | undefined;
  let releaseFirst: (() => void) | undefined;
  const firstPaused = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted: (() => void) | undefined;
  const firstDidStart = new Promise<void>((resolve) => { firstStarted = resolve; });

  const run = async (workflowId: string, pause?: Promise<void>) => {
    await gate.run(async () => { activeWorkflowId = workflowId; });
    if (workflowId === 'workflow-1') firstStarted?.();
    if (pause) await pause;
    assertCurrentWorkflow(workflowId, activeWorkflowId, false);
    events.push(`status:${workflowId}`);
  };

  const first = run('workflow-1', firstPaused);
  await firstDidStart;
  await run('workflow-2');
  releaseFirst?.();
  await assert.rejects(first, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.deepEqual(events, ['status:workflow-2']);
});

test('side-panel recovery acceptance rejects stale identities and accepts a valid reload replay', () => {
  const request: StepRecoveryRequest = { recoveryId: 'recovery', ...recoveryRequest() };
  const envelope = {
    provider: request.provider,
    requestId: request.failedRequestId,
    workflowId: request.workflowId,
    payload: request,
  };
  const context = {
    clientId: request.clientId,
    sessionId: request.sessionId,
    activeWorkflowId: undefined,
    currentRecoveryId: undefined,
    ignoredWorkflowIds: new Set<string>(),
    completedWorkflowIds: new Set<string>(),
    handledRecoveryIds: new Set<string>(),
  };
  assert.deepEqual(acceptStepRecoveryMessage(envelope, context), request);

  const rejected = [
    { envelope: { ...envelope, provider: 'grok' }, context },
    { envelope: { ...envelope, requestId: 'old-request' }, context },
    { envelope: { ...envelope, workflowId: 'old-workflow' }, context },
    { envelope: { ...envelope, payload: { ...request, clientId: 'old-client' } }, context },
    { envelope: { ...envelope, payload: { ...request, sessionId: 'old-session' } }, context },
    { envelope, context: { ...context, activeWorkflowId: 'other-workflow' } },
    { envelope, context: { ...context, currentRecoveryId: request.recoveryId } },
    { envelope, context: { ...context, ignoredWorkflowIds: new Set([request.workflowId]) } },
    { envelope, context: { ...context, completedWorkflowIds: new Set([request.workflowId]) } },
    { envelope, context: { ...context, handledRecoveryIds: new Set([request.recoveryId]) } },
  ];
  for (const candidate of rejected) {
    assert.equal(acceptStepRecoveryMessage(candidate.envelope, candidate.context), undefined);
  }
});

test('a stale workflow completion cannot clear the current recovery prompt', () => {
  const request: StepRecoveryRequest = { recoveryId: 'recovery', ...recoveryRequest() };
  assert.equal(shouldClearStepRecovery(request, { done: true, workflowId: 'old-workflow' }), false);
  assert.equal(shouldClearStepRecovery(request, { done: false, workflowId: request.workflowId }), false);
  assert.equal(shouldClearStepRecovery(request, { done: true, workflowId: request.workflowId }), true);
});

test('successful completion keeps the workflow open for a late final response but rejects late recovery', () => {
  const workflowId = 'workflow';
  const completed = new Set<string>([workflowId]);
  const ignored = new Set<string>();
  const active = activeWorkflowAfterStatus(workflowId, { workflowId, done: true, cancelled: false });
  assert.equal(active, workflowId);
  assert.equal(acceptWorkflowResponse(workflowId, active, ignored), true);

  const request: StepRecoveryRequest = { recoveryId: 'late-recovery', ...recoveryRequest() };
  assert.equal(acceptStepRecoveryMessage({
    provider: request.provider,
    requestId: request.failedRequestId,
    workflowId,
    payload: request,
  }, {
    clientId: request.clientId,
    sessionId: request.sessionId,
    activeWorkflowId: active,
    ignoredWorkflowIds: ignored,
    completedWorkflowIds: completed,
    handledRecoveryIds: new Set(),
  }), undefined);
});

function recoveryRequest(): Omit<StepRecoveryRequest, 'recoveryId'> {
  return {
    workflowId: 'workflow',
    sessionId: 'session',
    clientId: 'client',
    provider: 'claude',
    failedRequestId: 'request',
    reason: 'limited',
  };
}

function createHarness(options: {
  decisions: StepRecoveryAction[];
  failAttempts: Set<number>;
  rawError?: string;
}) {
  let attempt = 0;
  let requestSequence = 0;
  const decisions = [...options.decisions];
  const sends: { provider: AIProvider; prompt: string; workflowId: string; requestId: string }[] = [];
  const rolesSeen: { provider: AIProvider; labelKey: string; requestId: string }[] = [];
  const statuses: { round: number; provider: AIProvider }[] = [];
  const resets: { provider: AIProvider; requestId: string; workflowId: string }[] = [];
  const recoveryRequests: { provider: AIProvider; requestId: string; error: unknown }[] = [];
  const cancelled: string[] = [];
  const events: string[] = [];
  let aborted = false;

  const dependencies: RoundtableWorkflowDependencies = {
    checkAborted: () => {
      if (aborted) throw new DOMException('Workflow cancelled', 'AbortError');
    },
    providerName: (provider) => provider,
    buildPrompt: (text, round, provider, history) => `${text}|${round}|${provider}|${history.map((item) => item.text).join(',')}`,
    createRequestId: () => `request-${++requestSequence}`,
    sendStatus: async (round, provider) => { statuses.push({ round, provider }); events.push(`status:${round}:${provider}`); },
    sendRoleAssignment: async (provider, labelKey, requestId) => { rolesSeen.push({ provider, labelKey, requestId }); events.push(`role:${requestId}`); },
    sendAndWait: async (provider, prompt, workflowId, requestId) => {
      attempt += 1;
      sends.push({ provider, prompt, workflowId, requestId });
      events.push(`send:${requestId}`);
      if (options.failAttempts.has(attempt)) {
        throw new ProviderRequestError(provider, workflowId, requestId, options.rawError ?? 'provider failed');
      }
      return `answer-${requestId}`;
    },
    requestRecovery: async (provider, error, _workflowId, requestId) => {
      recoveryRequests.push({ provider, requestId, error });
      events.push(`recovery:${requestId}`);
      const decision = decisions.shift();
      assert.ok(decision, 'a recovery decision is required for every simulated failure');
      events.push(`decision:${decision}`);
      return decision;
    },
    resetProvider: async (provider, requestId, workflowId) => {
      resets.push({ provider, requestId, workflowId });
      events.push(`reset:${requestId}`);
    },
    cancelWorkflow: async (workflowId) => {
      cancelled.push(workflowId);
      aborted = true;
    },
  };

  return {
    dependencies,
    sends,
    roles: rolesSeen,
    statuses,
    resets,
    recoveryRequests,
    cancelled,
    events,
  };
}
