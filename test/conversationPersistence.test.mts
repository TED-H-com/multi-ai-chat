import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONSULT_ROLES, DEFAULT_DEBATE_ROLES, DEFAULT_CODING_ROLES, DEFAULT_ROUNDTABLE_ROLES } from '../src/shared/constants.ts';
import {
  commitActiveConversation,
  createConversationPersister,
  payloadFromInputs,
  storageReadFailed,
  toPersistPayload,
  usableConversations,
  prepareNewConversation,
} from '../src/shared/conversationPersistence.ts';
import type { ChatMessage, Conversation } from '../src/shared/types.ts';

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: extra.title ?? id,
    mode: extra.mode ?? 'free',
    roles: extra.roles,
    messages: extra.messages ?? [],
    providerUrls: extra.providerUrls,
    createdAt: extra.createdAt ?? 1,
    updatedAt: extra.updatedAt ?? 1,
  };
}

function msg(id: string, role: ChatMessage['role'], content: string, rest: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content, timestamp: 1, ...rest };
}

for (const [mode, roles] of [['coding', DEFAULT_CODING_ROLES], ['roundtable', DEFAULT_ROUNDTABLE_ROLES]] as const) {
  test(`New chat preserves selected ${mode} mode and role assignments without old provider context`, () => {
    const history = conv('previous', { messages: [msg('question', 'user', 'Keep my old conversation')], providerUrls: { grok: 'https://grok.com/chat/previous' } });
    const selectedRoles = { ...roles };
    const result = prepareNewConversation([history], mode, selectedRoles, 'Untitled', () => 'next', 200);
    assert.equal(result.conversation.mode, mode);
    assert.deepEqual(result.conversation.roles, selectedRoles);
    assert.notEqual(result.conversation.roles, selectedRoles);
    assert.deepEqual(result.conversation.messages, []);
    assert.deepEqual(result.conversation.providerUrls, {});
    assert.equal(result.conversations[1], history);
    const payload = payloadFromInputs({ conversations: result.conversations, activeConversationId: 'next', messages: [], mode, roles: selectedRoles, providerUrls: {} }, 'Untitled', 201);
    assert.equal(payload?.conversations[0].mode, mode);
    assert.deepEqual(payload?.conversations[0].roles, selectedRoles);
  });
}

test('reusing an empty Free chat cannot reset the selected Coding mode', () => {
  const empty = conv('reuse', { mode: 'free', providerUrls: { chatgpt: 'https://chatgpt.com/old' } });
  const result = prepareNewConversation([empty], 'coding', DEFAULT_CODING_ROLES, 'New', () => { throw new Error('must reuse'); }, 300);
  assert.equal(result.conversation.id, 'reuse');
  assert.equal(result.conversation.mode, 'coding');
  assert.equal(result.conversations.length, 1);
  assert.deepEqual(result.conversations[0].providerUrls, {});
  assert.equal(empty.mode, 'free');
});

test('reusing an empty chat leaves every existing saved conversation intact', () => {
  const history = Array.from({ length: 35 }, (_, index) => conv(`saved-${index}`, { messages: [msg(`m-${index}`, 'user', `Saved question ${index}`)] }));
  const result = prepareNewConversation([...history, conv('empty')], 'roundtable', DEFAULT_ROUNDTABLE_ROLES, 'New');
  assert.equal(result.conversations.length, 36);
  for (const original of history) assert.equal(result.conversations.find(item => item.id === original.id), original);
});

test('pending autosave writes the latest snapshot so a deleted conversation stays deleted', () => {
  const writes: string[][] = [];
  let pending: (() => void) | undefined;
  const persister = createConversationPersister({
    delayMs: 20,
    write: (payload) => { writes.push(payload.conversations.map((conversation) => conversation.id)); },
    schedule: (fn) => { pending = fn; return 1; },
    cancel: () => { pending = undefined; },
  });
  persister.enable();
  persister.track(toPersistPayload([conv('A'), conv('B')], 'A'));
  persister.debounce();
  persister.track(toPersistPayload([conv('A')], 'A'));
  assert.equal(writes.length, 0);
  pending?.();
  assert.deepEqual(writes, [['A']]);
});

test('flush after delete cancels the pending autosave that still listed the deleted conversation', () => {
  const writes: string[][] = [];
  let pending: (() => void) | undefined;
  const persister = createConversationPersister({
    write: (payload) => { writes.push(payload.conversations.map((conversation) => conversation.id)); },
    schedule: (fn) => { pending = fn; return 1; },
    cancel: () => { pending = undefined; },
  });
  persister.enable();
  persister.track(toPersistPayload([conv('A'), conv('B')], 'A'));
  persister.debounce();
  persister.track(toPersistPayload([conv('A')], 'A'));
  persister.flush();
  assert.equal(pending, undefined);
  pending?.();
  assert.deepEqual(writes, [['A']]);
});

test('switch then immediate flush stores the new active id and the leaving conversation snapshot', () => {
  const writes: ReturnType<typeof toPersistPayload>[] = [];
  const persister = createConversationPersister({
    write: (payload) => { writes.push(payload); },
  });
  persister.enable();
  const leaving = conv('A', { mode: 'consult', messages: [msg('u1', 'user', 'hello')] });
  persister.track(toPersistPayload([leaving, conv('B')], 'A'));
  persister.debounce();
  const committed = commitActiveConversation([leaving, conv('B')], {
    id: 'A',
    messages: [msg('u1', 'user', 'hello'), msg('a1', 'ai', 'answer', { provider: 'chatgpt' })],
    mode: 'consult',
    roles: DEFAULT_CONSULT_ROLES,
    providerUrls: { chatgpt: 'https://chatgpt.com/c/1' },
  }, 'New chat', 50);
  persister.track(toPersistPayload(committed, 'B'));
  persister.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].activeConversationId, 'B');
  assert.equal(writes[0].conversations.find((conversation) => conversation.id === 'A')?.messages.at(-1)?.content, 'answer');
});

test('pagehide flush issues the latest write even if an older write is still pending', () => {
  const writes: string[] = [];
  const persister = createConversationPersister({
    write: (payload) => { writes.push(payload.activeConversationId); },
  });
  persister.enable();
  persister.track(toPersistPayload([conv('A')], 'A'));
  persister.flush();
  persister.track(toPersistPayload([conv('A'), conv('B')], 'B'));
  persister.flush();
  assert.deepEqual(writes, ['A', 'B']);
});

test('a failed initial get does not write, so empty hydrate cannot overwrite storage', () => {
  const writes: unknown[] = [];
  const persister = createConversationPersister({
    write: (payload) => { writes.push(payload); },
  });
  persister.track(toPersistPayload([conv('fresh')], 'fresh'));
  persister.flush();
  persister.debounce();
  assert.equal(writes.length, 0);
  assert.equal(storageReadFailed({ message: 'The browser is shutting down.' }), true);
  assert.equal(storageReadFailed(undefined), false);
});

test('malformed stored entries are skipped without rewriting valid transcripts', () => {
  const streaming = msg('r1-streaming', 'ai', 'partial', { provider: 'claude' });
  const long = msg('u1', 'user', 'x'.repeat(5_000));
  const valid = conv('keep', {
    mode: 'debate',
    roles: DEFAULT_DEBATE_ROLES,
    messages: [long, streaming],
    providerUrls: { chatgpt: 'https://chatgpt.com/c/old' },
  });
  const usable = usableConversations([
    null,
    'nope',
    { title: 'missing-id' },
    valid,
    { id: '' },
    3,
    { id: 'bad-messages', messages: 5 },
    { id: 'holes', mode: 'free', messages: [null, streaming, { id: 1, content: 'x' }, long], providerUrls: { grok: 'https://grok.com/c/1' } },
  ]);
  assert.deepEqual(usable.map((conversation) => conversation.id), ['keep', 'holes']);
  assert.equal(usable[0], valid);
  assert.equal(usable[0].messages[0]?.content.length, 5_000);
  assert.equal(usable[0].messages[1]?.id, 'r1-streaming');
  assert.equal(usable[0].providerUrls?.chatgpt, 'https://chatgpt.com/c/old');
  assert.equal(usable[0].mode, 'debate');
  assert.deepEqual(usable[0].roles, DEFAULT_DEBATE_ROLES);
  assert.deepEqual(usable[1].messages.map((message) => message.id), ['r1-streaming', 'u1']);
  assert.equal(usable[1].providerUrls?.grok, 'https://grok.com/c/1');
});

test('storage write rejections are handled so a failed set does not surface unhandled', async () => {
  const failures: unknown[] = [];
  const onUnhandled = (reason: unknown) => { failures.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const persister = createConversationPersister({
      write: () => Promise.reject(new Error('quota')),
    });
    persister.enable();
    persister.track(toPersistPayload([conv('A')], 'A'));
    persister.flush();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(failures, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('current snapshot on close persists the live mode without a versioned rewrite', () => {
  const payload = payloadFromInputs({
    conversations: [conv('A', { mode: 'consult', roles: DEFAULT_CONSULT_ROLES })],
    activeConversationId: 'A',
    messages: [msg('u1', 'user', 'hello')],
    mode: 'free',
    roles: DEFAULT_DEBATE_ROLES,
    providerUrls: {},
  }, 'New chat');
  assert.equal(payload?.activeConversationId, 'A');
  assert.equal(payload?.conversations[0].mode, 'free');
  assert.equal(payload?.conversations[0].roles, undefined);
  assert.equal('conversationStateVersion' in (payload ?? {}), false);
});
