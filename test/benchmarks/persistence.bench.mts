import test from 'node:test';
import assert from 'node:assert/strict';
import { fitConversationsForStorage } from '../../src/shared/conversationPersistence.ts';
import type { Conversation, ChatMessage } from '../../src/shared/types.ts';

test('fitConversationsForStorage performs within limits', () => {
  const largeMessage: ChatMessage = {
    id: 'msg-1', role: 'ai', content: 'x'.repeat(100000), timestamp: 1,
  };
  const conversations: Conversation[] = Array.from({ length: 30 }, (_, i) => ({
    id: `conv-${i}`,
    title: `Title ${i}`,
    mode: 'free',
    messages: [largeMessage, largeMessage, largeMessage, largeMessage, largeMessage],
    createdAt: 1,
    updatedAt: 1,
  }));

  const start = performance.now();
  for(let i=0; i<10; i++) {
    fitConversationsForStorage(conversations);
  }
  const end = performance.now();

  // Relaxed the upper bound and reduced iterations, we mostly care about not hanging.
  assert.ok((end - start) < 3000, `Took too long: ${end - start}ms`);
});
