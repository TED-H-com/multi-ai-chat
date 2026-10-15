import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

interface TurnModule {
  runCheckpointedRecoverableTurn: (turn: unknown, prompt: string, workflowId: string, dependencies: unknown) => Promise<string>;
  ProviderRequestError: new (provider: string, workflowId: string, requestId: string, reason: unknown) => Error;
}

function loadTurnModule(): TurnModule {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const context = vm.createContext({
    crypto: { randomUUID: () => 'generated-id' },
    DOMException,
    setTimeout,
    clearTimeout,
  });
  const load = (file: string): Record<string, unknown> => {
    const cached = cache.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(file, module);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = vm.runInContext(`(function(require, module, exports) {${source}\n})`, context, { filename: file });
    run((relative: string) => load(path.resolve(path.dirname(file), `${relative}.ts`)), module, module.exports);
    return module.exports;
  };
  return load(path.join(root, 'src/background/recoverableWorkflowTurn.ts')) as unknown as TurnModule;
}

function dependencies(options: {
  restored?: string;
  failFirst?: boolean;
  action?: 'retry' | 'skip' | 'cancel';
}, ProviderRequestError: TurnModule['ProviderRequestError']) {
  let attempts = 0;
  const starts: string[] = [];
  const completions: Array<{ response: string; requestId?: string }> = [];
  const assignment: string[] = [];
  const resets: string[] = [];
  const requests: string[] = [];
  return {
    dependencies: {
      checkAborted: () => {},
      createRequestId: () => `request-${++attempts}`,
      sendRoleAssignment: async (_provider: string, _label: string, requestId: string) => { assignment.push(requestId); },
      sendAndWait: async (_provider: string, _prompt: string, _workflow: string, requestId: string) => {
        requests.push(requestId);
        if (options.failFirst && requests.length === 1) {
          throw new ProviderRequestError('gemini', 'workflow', requestId, 'not sent');
        }
        return `response:${requestId}`;
      },
      requestRecovery: async () => options.action ?? 'skip',
      resetProvider: async (_provider: string, requestId: string) => { resets.push(requestId); },
      cancelWorkflow: async () => {},
      contributionForTurn: () => options.restored ? { text: options.restored } : undefined,
      onTurnStarted: (turn: { key: string }) => { starts.push(turn.key); },
      onTurnCompleted: (_turn: unknown, response: string, requestId?: string) => { completions.push({ response, requestId }); },
    },
    starts,
    completions,
    assignment,
    resets,
    requests,
  };
}

test('all five providers retain their exact turn identity through a recovered retry', async () => {
  const { runCheckpointedRecoverableTurn, ProviderRequestError } = loadTurnModule();
  for (const provider of ['chatgpt', 'gemini', 'grok', 'meta', 'claude']) {
    const harness = dependencies({ failFirst: true, action: 'retry' }, ProviderRequestError);
    const response = await runCheckpointedRecoverableTurn(
      { key: `debate:${provider}`, provider, labelKey: 'role.pro', role: 'pro' },
      'English test prompt', 'workflow', harness.dependencies,
    );
    assert.equal(response, 'response:request-2');
    assert.deepEqual(harness.requests, ['request-1', 'request-2']);
    assert.deepEqual(harness.resets, ['request-1']);
    assert.deepEqual(harness.completions, [{ response: 'response:request-2', requestId: 'request-2' }]);
  }
});

test('a skipped turn is checkpointed as one unavailable contribution without an automatic replay', async () => {
  const { runCheckpointedRecoverableTurn, ProviderRequestError } = loadTurnModule();
  const harness = dependencies({ failFirst: true, action: 'skip' }, ProviderRequestError);
  const response = await runCheckpointedRecoverableTurn(
    { key: 'consult:first', provider: 'gemini', labelKey: 'role.first', role: 'first' },
    'English test prompt', 'workflow', harness.dependencies,
  );
  assert.match(response, /no response/);
  assert.deepEqual(harness.requests, ['request-1']);
  assert.deepEqual(harness.resets, ['request-1']);
  assert.equal(harness.completions[0]?.requestId, 'request-1');
});

test('an exact checkpoint contribution is reused without sending, assigning a role, or presenting recovery', async () => {
  const { runCheckpointedRecoverableTurn, ProviderRequestError } = loadTurnModule();
  const harness = dependencies({ restored: 'already collected response' }, ProviderRequestError);
  const response = await runCheckpointedRecoverableTurn(
    { key: 'coding:spec', provider: 'claude', labelKey: 'role.planner', role: 'planner' },
    'English test prompt', 'workflow', harness.dependencies,
  );
  assert.equal(response, 'already collected response');
  assert.deepEqual(harness.requests, []);
  assert.deepEqual(harness.assignment, []);
  assert.deepEqual(harness.starts, []);
  assert.deepEqual(harness.completions, []);
});
