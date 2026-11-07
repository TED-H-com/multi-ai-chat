import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflowScope,
  createWorkflowCancellation,
  isValidWorkflowId,
  activeCancellationTarget,
  rebindWorkflowScope,
  WorkflowIdRegistry,
  WorkflowLifecycleRegistry,
} from '../src/shared/workflowScope.ts';

test('Integration & Edge Case: createWorkflowScope e2e workflow generation', async (t) => {
  await t.test('creates valid scope', () => {
    const scope = createWorkflowScope('session1', 'client1');
    assert.equal(scope.sessionId, 'session1');
    assert.equal(scope.clientId, 'client1');
    assert.ok(isValidWorkflowId(scope.workflowId));
  });

  await t.test('throws on invalid id', () => {
    assert.throws(() => createWorkflowScope('session1', 'client1', () => 'invalid-id'));
  });
});

test('Integration & Edge Case: createWorkflowCancellation critical path', async (t) => {
  await t.test('returns scope if workflowId is provided', () => {
    const scope = createWorkflowCancellation('session1', 'client1', 'id1');
    assert.deepEqual(scope, { workflowId: 'id1', sessionId: 'session1', clientId: 'client1' });
  });

  await t.test('returns undefined if workflowId is not provided', () => {
    assert.equal(createWorkflowCancellation('session1', 'client1', undefined), undefined);
  });
});

test('Integration & Edge Case: isValidWorkflowId boundaries', async (t) => {
  await t.test('validates correctly', () => {
    assert.ok(isValidWorkflowId('123e4567-e89b-42d3-a456-426614174000'));
    assert.ok(!isValidWorkflowId('not-a-uuid'));
    assert.ok(!isValidWorkflowId(null as unknown));
    assert.ok(!isValidWorkflowId(undefined as unknown));
    assert.ok(!isValidWorkflowId(123 as unknown));
  });
});

test('Integration & Edge Case: activeCancellationTarget concurrency checks', async (t) => {
  await t.test('returns active if they match', () => {
    assert.equal(activeCancellationTarget('id1', 'id1'), 'id1');
  });

  await t.test('returns undefined if they do not match', () => {
    assert.equal(activeCancellationTarget('id1', 'id2'), undefined);
    assert.equal(activeCancellationTarget('id1', undefined), undefined);
  });
});

test('Integration & Edge Case: rebindWorkflowScope recovery tracking', async (t) => {
  await t.test('rebinds correctly if matching', () => {
    const scope = { workflowId: 'id1', sessionId: 'session1', clientId: 'client1' };
    const rebound = rebindWorkflowScope(scope, 'id1', 'session1', 'client2');
    assert.deepEqual(rebound, { workflowId: 'id1', sessionId: 'session1', clientId: 'client2' });
  });

  await t.test('returns undefined if not matching', () => {
    const scope = { workflowId: 'id1', sessionId: 'session1', clientId: 'client1' };
    assert.equal(rebindWorkflowScope(scope, 'id2', 'session1', 'client2'), undefined);
    assert.equal(rebindWorkflowScope(scope, 'id1', 'session2', 'client2'), undefined);
    assert.equal(rebindWorkflowScope(undefined, 'id1', 'session1', 'client2'), undefined);
  });
});

test('Integration & Edge Case: WorkflowIdRegistry unique assertions', async (t) => {
  await t.test('claims valid ids', () => {
    const registry = new WorkflowIdRegistry();
    const id = '123e4567-e89b-42d3-a456-426614174000';
    assert.ok(registry.claim(id));
  });

  await t.test('rejects duplicate claims', () => {
    const registry = new WorkflowIdRegistry();
    const id = '123e4567-e89b-42d3-a456-426614174000';
    registry.claim(id);
    assert.ok(!registry.claim(id));
  });

  await t.test('rejects invalid ids', () => {
    const registry = new WorkflowIdRegistry();
    assert.ok(!registry.claim('invalid-id'));
    assert.ok(!registry.claim(null as unknown));
  });
});

test('Integration & Edge Case: WorkflowLifecycleRegistry comprehensive lifecycle', async (t) => {
  await t.test('registers and retrieves valid scope', () => {
    const registry = new WorkflowLifecycleRegistry();
    const scope = createWorkflowScope('session1', 'client1');
    assert.ok(registry.register(scope));
    assert.deepEqual(registry.current(scope.workflowId), scope);
  });

  await t.test('rejects invalid scope registration', () => {
    const registry = new WorkflowLifecycleRegistry();
    const id = '123e4567-e89b-42d3-a456-426614174000';
    assert.ok(!registry.register({ workflowId: id, sessionId: '', clientId: 'client1' }));
    assert.ok(!registry.register({ workflowId: id, sessionId: 'session1', clientId: '' }));
    assert.ok(!registry.register({ workflowId: 'invalid-id', sessionId: 'session1', clientId: 'client1' }));
  });

  await t.test('rejects duplicate scope registration', () => {
    const registry = new WorkflowLifecycleRegistry();
    const scope = createWorkflowScope('session1', 'client1');
    assert.ok(registry.register(scope));
    assert.ok(!registry.register(scope));
  });

  await t.test('requests cancellation', () => {
    const registry = new WorkflowLifecycleRegistry();
    const scope = createWorkflowScope('session1', 'client1');
    registry.register(scope);

    assert.deepEqual(registry.requestCancellation(scope), scope);
    assert.throws(() => registry.assertCanStart(scope.workflowId), /Workflow cancelled/);
  });

  await t.test('rejects invalid cancellation request', () => {
    const registry = new WorkflowLifecycleRegistry();
    const scope = createWorkflowScope('session1', 'client1');
    registry.register(scope);

    assert.equal(registry.requestCancellation(null), undefined);
    assert.equal(registry.requestCancellation({ workflowId: 'wrong-id', sessionId: 'session1', clientId: 'client1' }), undefined);
    assert.equal(registry.requestCancellation({ workflowId: scope.workflowId, sessionId: 'wrong-session', clientId: 'client1' }), undefined);
    assert.equal(registry.requestCancellation({ workflowId: scope.workflowId, sessionId: 'session1', clientId: 'wrong-client' }), undefined);
  });

  await t.test('rebinds correctly', () => {
    const registry = new WorkflowLifecycleRegistry();
    const scope = createWorkflowScope('session1', 'client1');
    registry.register(scope);

    const rebound = registry.rebind(scope.workflowId, 'session1', 'client2');
    assert.deepEqual(rebound, { workflowId: scope.workflowId, sessionId: 'session1', clientId: 'client2' });
    assert.deepEqual(registry.current(scope.workflowId), rebound);
  });

  await t.test('returns undefined on invalid rebind', () => {
    const registry = new WorkflowLifecycleRegistry();
    const scope = createWorkflowScope('session1', 'client1');
    registry.register(scope);

    assert.equal(registry.rebind('wrong-id', 'session1', 'client2'), undefined);
    assert.equal(registry.rebind(scope.workflowId, 'wrong-session', 'client2'), undefined);
  });

  await t.test('manages recovery owners', () => {
    const registry = new WorkflowLifecycleRegistry();
    const id = '123e4567-e89b-42d3-a456-426614174000';

    assert.ok(registry.canOwnRecovery(id, 'client1'));
    registry.revokeRecoveryOwner(id, 'client1');
    assert.ok(!registry.canOwnRecovery(id, 'client1'));
    assert.ok(registry.canOwnRecovery(id, 'client2'));
  });

  await t.test('finishes correctly', () => {
    const registry = new WorkflowLifecycleRegistry();
    const scope = createWorkflowScope('session1', 'client1');
    registry.register(scope);

    registry.revokeRecoveryOwner(scope.workflowId, 'client1');
    registry.requestCancellation(scope);

    registry.finish(scope.workflowId);

    assert.equal(registry.current(scope.workflowId), undefined);
    assert.doesNotThrow(() => registry.assertCanStart(scope.workflowId));
    assert.ok(registry.canOwnRecovery(scope.workflowId, 'client1'));
  });
});
