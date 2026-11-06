import assert from 'node:assert/strict';
import test from 'node:test';
import { composerMatchesPrompt, readComposerText } from '../src/content/composerText.ts';

const rich = (innerText: string) => ({ tagName: 'DIV', innerText, textContent: innerText.replace(/\n/g, '') }) as unknown as Element;

test('rich-editor matching tolerates observed paragraph spacing without losing source distinctions', () => {
  assert.equal(composerMatchesPrompt(rich("First paragraph\n\nThe user's next paragraph"), "First paragraph\nThe user's next paragraph"), true);
  assert.equal(composerMatchesPrompt(rich('hello\nworld'), 'helloworld'), false);
  assert.equal(composerMatchesPrompt(rich('Use a  b'), 'Use a b'), false);
  assert.equal(composerMatchesPrompt(rich('Keep "a\n\nb"'), 'Keep "a\nb"'), false);
  assert.equal(composerMatchesPrompt(rich('Keep `a  b`'), 'Keep `a b`'), false);
  assert.equal(composerMatchesPrompt(rich('**OK**'), 'OK'), false);
});

test('plain input readback uses its current value rather than DOM text', () => {
  const input = { tagName: 'TEXTAREA', value: 'current draft', textContent: 'old draft' } as unknown as Element;
  assert.equal(readComposerText(input), 'current draft');
  assert.equal(composerMatchesPrompt(input, 'old draft'), false);
});
