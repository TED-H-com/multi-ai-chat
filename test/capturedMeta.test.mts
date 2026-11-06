import assert from 'node:assert/strict';
import test from 'node:test';
import { capturedMetaResponse } from './helpers/capturedMetaResponse.mts';

test('the captured live Meta Coding response retains complete executable lines without status or duplicate previews', () => {
  const response = capturedMetaResponse();
  assert.equal(response.length, 415);
  assert.match(response, /^MULTIAI_CODING_1421\n\n```javascript\nfunction add/);
  assert.match(response, /\n\/\/ tests\nconsole\.assert/);
  assert.match(response, /throw new TypeError/);
  assert.match(response, /throw new RangeError/);
  assert.equal(response.match(/function add/g)?.length, 1);
  assert.equal(response.match(/```javascript/g)?.length, 1);
  assert.doesNotMatch(response, /Show thinking|Implementing add|lines hidden|Image generated|I'm writing/);
});
