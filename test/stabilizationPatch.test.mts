import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { grokComposerMatches, readGrokComposerText } from '../src/content/grokDom.ts';
import { GEMINI_USER_MESSAGE_SELECTORS } from '../src/content/geminiDom.ts';
import { distinctSemanticResponseTurns, captureSemanticResponseBaseline, currentSemanticResponseText } from '../src/content/responseTracking.ts';
import { appendResponseLanguagePolicy } from '../src/shared/promptLanguage.ts';
import { contentMatchesPrompt } from '../src/content/sendConfirmation.ts';

test('real workflow policy apostrophes are contractions, not quoted multiline source', () => {
  const prompt = appendResponseLanguagePolicy('--- Current user task ---\nReply briefly.\n--- End current user task ---');
  const visual = prompt.split('\n').map(line => ` ${line} `).join('\n\n');
  const composer = { tagName: 'DIV', innerText: visual, textContent: prompt.replace(/\n/g, '') };
  assert.equal(grokComposerMatches(composer as unknown as Element, prompt), true);
  assert.equal(contentMatchesPrompt(visual, prompt), true);
  assert.equal(contentMatchesPrompt(visual + ' changed', prompt), false);
  assert.equal(contentMatchesPrompt("Keep 'a b'", "Keep 'a  b'"), false);
});

test('Grok ProseMirror readback tolerates visual paragraph breaks without accepting the wrong prompt', () => {
  const composer = { tagName: 'DIV', innerText: 'First paragraph\n\nSecond paragraph', textContent: 'First paragraphSecond paragraph' };
  assert.equal(readGrokComposerText(composer as unknown as Element), composer.innerText);
  assert.equal(grokComposerMatches(composer as unknown as Element, 'First paragraph\nSecond paragraph'), true);
  assert.equal(grokComposerMatches(composer as unknown as Element, 'First paragraph\nDifferent paragraph'), false);
  assert.equal(grokComposerMatches(composer as unknown as Element, 'First paragraph\nSecond paragraph plus a sentence'), false);
  const quotes = { ...composer, innerText: 'Say "a b" carefully', textContent: 'Say "a b" carefully' };
  assert.equal(grokComposerMatches(quotes as unknown as Element, 'Say "a  b" carefully'), false);
});

test('Grok textarea uses its live value, not a potentially empty textContent', () => {
  const input = { tagName: 'TEXTAREA', value: 'A new prompt', textContent: '' };
  assert.equal(grokComposerMatches(input as unknown as Element, 'A new prompt'), true);
  assert.equal(grokComposerMatches(input as unknown as Element, 'Old prompt'), false);
});

test('mixed old/new assistant markup does not hide a new response after an older selector matched', () => {
  const old = { id: 'old', text: 'Old answer', contains(other: unknown) { return other === nested; } };
  const nested = { id: 'nested', text: 'Old answer', contains(_other: unknown) { return false; } };
  const fresh = { id: 'new', text: 'New genuine answer', contains(_other: unknown) { return false; } };
  const initial = distinctSemanticResponseTurns([old, nested]);
  assert.deepEqual(initial, [old]);
  const baseline = captureSemanticResponseBaseline(initial, (item) => item.text);
  const current = distinctSemanticResponseTurns([old, nested, fresh]);
  assert.deepEqual(current, [old, fresh]);
  assert.equal(currentSemanticResponseText(current, baseline, (item) => item.text), 'New genuine answer');
});

test('Gemini adapter recognizes real user-query containers for positive send evidence', () => {
  assert.ok(GEMINI_USER_MESSAGE_SELECTORS.some(selector => selector.includes('user-query')));
  const src = readFileSync(new URL('../src/content/gemini.ts', import.meta.url), 'utf8');
  assert.match(src, /userMessageSelectors:\s*GEMINI_USER_MESSAGE_SELECTORS/);
  assert.match(src, /sendConfirmationTimeoutMs:\s*30_000/);
  assert.match(src, /immediateSendAfterInsertion:\s*true/);
});

test('Side Panel exposes a dedicated vertically scrollable complete workflow log', () => {
  const src = readFileSync(new URL('../src/sidepanel/App.tsx', import.meta.url), 'utf8');
  assert.match(src, /View full workflow log/);
  assert.match(src, /aria-label="Complete workflow history"/);
  assert.match(src, /role="log"/);
  assert.match(src, /min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto/);
  assert.match(src, /trace\.map\(\(entry\) =>/);
});
