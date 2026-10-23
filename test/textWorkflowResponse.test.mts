import assert from 'node:assert/strict';
import test from 'node:test';
import { isMissingWorkflowText } from '../src/background/textWorkflowResponse.ts';
import { PROMPTS } from '../src/shared/constants.ts';

test('text workflows reject only empty or media-only envelopes while accepting real prose and code', () => {
  for (const response of ['', '  ', '[Image generated]', ' [Image generated: a diagram] ']) assert.equal(isMissingWorkflowText(response), true);
  for (const response of ['function add(a,b){return a+b;}', '```python\nprint(42)\n```', 'Review: needs tests.', '[Image generated]\nActual explanatory text']) assert.equal(isMissingWorkflowText(response), false);
});

test('Coding acceptance and Roundtable distinguish unavailable evidence from success or consensus', () => {
  const acceptance = PROMPTS.coding.plannerAcceptance('Keep it under 40 words', '(no response — skipped)', 'Meta AI', 'Specification');
  const debate = PROMPTS.roundtable.buildPrompt('Keep it under 40 words', 4, 'Grok', [{ name: 'Meta AI', round: 1, text: '(no response — skipped)' }]);
  for (const prompt of [acceptance, debate]) {
    assert.match(prompt, /not agreement or abstention/);
    assert.match(prompt, /Do not claim a review passed or a consensus was established when the required evidence is missing/);
    assert.match(prompt, /Keep it under 40 words/);
  }
  assert.match(acceptance, /Missing source code cannot pass review or acceptance/);
  assert.match(acceptance, /Claim execution only when actual execution results are supplied/);
  assert.doesNotMatch(debate, /source code|fenced code blocks/);
});
