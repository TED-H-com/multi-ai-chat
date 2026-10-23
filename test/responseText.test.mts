// Uses Node's built-in node:test — no test framework dependency. Runs the TypeScript sources
// directly, which needs Node 22.18+ native type stripping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grokResponseContentRoot } from '../src/content/grokDom.ts';
import { isMetaResponseCandidate, isMetaResponseStreaming, metaResponseContentRoot, prepareMetaResponse } from '../src/content/metaDom.ts';
import {
  extractResponseContent,
  longerResponseText,
  serializeResponseText,
} from '../src/content/responseSerializer.ts';

// Why this matters: ChatGPT's "still generating" signal (the stop button) ends before the last
// render commits. Finalizing with only the text cached mid-stream hands the user half an answer,
// and that half is fed verbatim into the next provider's prompt.
test('a fuller re-read wins over the text cached mid-stream', () => {
  assert.equal(longerResponseText('first line', 'first line\nsecond\nthird'), 'first line\nsecond\nthird');
});

test('keeps the cache when the re-read finds nothing, so we never ship an empty response', () => {
  assert.equal(longerResponseText('complete answer', null), 'complete answer');
  assert.equal(longerResponseText('complete answer', ''), 'complete answer');
});

test('keeps the cache when the re-read is shorter, in case finalizing races a re-render', () => {
  assert.equal(longerResponseText('complete answer', 'compl'), 'complete answer');
});

// Code blocks are swapped for a placeholder and restored at the end. If that restore uses a
// string replacement, the `$&`, `$'` and `` $` `` that show up in ordinary shell snippets are
// expanded by String.replace as substitution patterns. The user gets rewritten code that still
// looks plausible — the hardest kind of corruption to notice.
test("code blocks containing $& / $' / $` are restored verbatim", () => {
  const code = "echo \"$&\" && echo '$`' && echo \"$'\" && echo \"$1\"";
  const root = element('DIV', [element('PRE', [element('CODE', [text(code)], { class: 'language-bash' })])]);
  assert.equal(serializeResponseText(root), '```bash\n' + code + '\n```');
});

test('Grok uses the outer assistant turn for identity but serializes only its Markdown answer', () => {
  const thinking = element('DIV', [text('Thought for 4s')], { class: 'thinking-container' });
  const answer = element('DIV', [text('Final answer only')], { class: 'response-content-markdown' });
  const outer = element('DIV', [thinking, answer], { 'data-testid': 'assistant-message' });

  assert.equal(extractResponseContent(
    outer as unknown as Element,
    grokResponseContentRoot,
  ), 'Final answer only');
});

test('response content extraction preserves plain-text and generated-image fallbacks', () => {
  const plain = element('DIV', [text('Plain answer')]);
  const image = element('IMG', [], { alt: 'A blue bird' });
  const imageTurn = element('DIV', [image], { 'data-testid': 'assistant-message' });

  assert.equal(extractResponseContent(plain as unknown as Element), 'Plain answer');
  assert.equal(extractResponseContent(imageTurn as unknown as Element), '[Image generated: A blue bird]');
});

test('Meta extracts the final Markdown body without thinking labels or transient status text', () => {
  const thinking = element('DIV', [text('Assessing debate arguments\nShow thinking')], { 'data-testid': 'thinking-status' });
  const answer = element('DIV', [element('P', [text('MULTIAI_OK')])], { class: 'ur-markdown prose' });
  const outer = element('DIV', [thinking, text("I'm weighing the arguments"), answer], { 'data-testid': 'assistant-message' });
  assert.equal(isMetaResponseCandidate(outer as unknown as Element), true);
  assert.equal(extractResponseContent(outer as unknown as Element, metaResponseContentRoot), 'MULTIAI_OK');
});

test('Meta does not cache a thinking-only turn as an answer before the Markdown body arrives', () => {
  const thinking = element('DIV', [text('Show thinking')], { 'data-testid': 'thinking-status' });
  const outer = element('DIV', [thinking], { 'data-testid': 'assistant-message' });
  assert.equal(isMetaResponseCandidate(outer as unknown as Element), false);
});

test('Meta preserves interleaved prose and sibling code fragments while excluding their controls', () => {
  const thinking = element('DIV', [text('Show thinking')], { 'data-testid': 'thinking-status' });
  const intro = element('DIV', [text('Complete implementation:')], { class: 'ur-markdown' });
  const code = element('PRE', [element('CODE', [text('function add(a, b) {\n  return a + b;\n}')])], { class: 'language-javascript' });
  const codeCard = element('DIV', [text('JavaScript'), code, text('14 lines hidden')], { class: 'markdown-content' });
  const ending = element('DIV', [text('Usage: add(2, 3).')], { class: 'ur-markdown' });
  const root = element('DIV', [thinking, intro, codeCard, ending]);
  assert.equal(extractResponseContent(root as unknown as Element, metaResponseContentRoot), 'Complete implementation:\n\n```javascript\nfunction add(a, b) {\n  return a + b;\n}\n```\n\nUsage: add(2, 3).');
});

test('a code-only Meta answer is accepted even when a thinking control remains mounted', () => {
  const thinking = element('DIV', [text('Show thinking')], { 'data-testid': 'thinking-status' });
  const code = element('PRE', [element('CODE', [text('const answer = 42;')])]);
  const root = element('DIV', [thinking, code]);
  assert.equal(isMetaResponseCandidate(root as unknown as Element), true);
  assert.equal(extractResponseContent(root as unknown as Element, metaResponseContentRoot), '```\nconst answer = 42;\n```');
});

test('Meta does not treat its invisible orbit logo as generated output before an answer mounts', () => {
  const logo = element('IMG', [], { src: '/images/cot_logo_static/orbit.png', class: 'invisible', alt: '' });
  const outer = element('DIV', [logo, element('CANVAS', [])]);
  assert.equal(isMetaResponseCandidate(outer as unknown as Element), false);
});

test('current Meta assistant shells cannot contribute transient labels before their answer fragments mount', () => {
  const shell = element('DIV', [text('Implementing add function Show thinking')], { 'data-message-role': 'assistant' });
  assert.equal(isMetaResponseCandidate(shell as unknown as Element), false);
  const answer = element('DIV', [element('DIV', [text('Final answer')], { class: 'ur-markdown' })], { 'data-message-role': 'assistant' });
  assert.equal(isMetaResponseCandidate(answer as unknown as Element), true);
});

test('Meta waits for explicit streaming completion even when text or code has already appeared', () => {
  const answer = element('DIV', [text('Intro before the implementation')], { class: 'ur-markdown' });
  const streaming = element('DIV', [answer], { 'data-streaming-state': 'STREAMING' });
  const complete = element('DIV', [answer], { 'data-streaming-state': 'DONE' });
  assert.equal(isMetaResponseStreaming(streaming as unknown as Element), true);
  assert.equal(isMetaResponseCandidate(streaming as unknown as Element), false);
  assert.equal(isMetaResponseStreaming(complete as unknown as Element), false);
  assert.equal(isMetaResponseCandidate(complete as unknown as Element), true);
});

test('Meta expands only response-local code previews once and waits for their mounted lines', () => {
  let clicks = 0;
  let folded = true;
  const fold = {
    disabled: false,
    getAttribute: (name: string) => name === 'aria-label' ? 'See all 23 lines' : 'false',
    click: () => { clicks++; },
  };
  const forbidden = ['Copy response', 'Download', 'Retry', 'Send', 'Show thinking'].map(label => ({
    getAttribute: () => label, click: () => { throw new Error(`Unexpected ${label}`); },
  }));
  const root = { querySelectorAll: () => [...forbidden, ...(folded ? [fold] : [])] };
  assert.equal(prepareMetaResponse(root as unknown as Element), false);
  assert.equal(prepareMetaResponse(root as unknown as Element), false);
  assert.equal(clicks, 1);
  folded = false;
  assert.equal(prepareMetaResponse(root as unknown as Element), true);
});

test('disabled Meta code controls cannot make a truncated preview ready', () => {
  const fold = { disabled: true, getAttribute: () => 'See all 28 lines', click: () => { throw new Error('disabled'); } };
  assert.equal(prepareMetaResponse({ querySelectorAll: () => [fold] } as unknown as Element), false);
});

test('Meta code keeps its observed data-lang marker', () => {
  const code = element('CODE', [text('const result = 42;')], { 'data-lang': 'javascript' });
  assert.equal(serializeResponseText(element('PRE', [code]) as unknown as Element), '```javascript\nconst result = 42;\n```');
});

test('Meta excludes the hidden five-line preview after expanding the complete code', () => {
  const preview = Object.assign(element('PRE', [element('CODE', [text('/** intro only */')])]), {
    closest: () => ({ className: 'prose hidden' }),
  });
  const full = element('PRE', [element('CODE', [text('/** intro only */\nfunction add(a, b) { return a + b; }')], { 'data-lang': 'javascript' })]);
  const root = element('DIV', [preview, full]);
  assert.equal(extractResponseContent(root as unknown as Element, metaResponseContentRoot), '```javascript\n/** intro only */\nfunction add(a, b) { return a + b; }\n```');
});

test('syntax-highlighted code keeps visual line boundaries and the language on its pre wrapper', () => {
  const code = Object.assign(element('CODE', [
    element('SPAN', [text('function add(a, b) {')]),
    element('SPAN', [text('  return a + b;')]),
    element('SPAN', [text('}')]),
  ]), { innerText: 'function add(a, b) {\n  return a + b;\n}' });
  const pre = element('PRE', [code], { class: 'language-javascript' });
  assert.equal(serializeResponseText(pre as unknown as Element), '```javascript\nfunction add(a, b) {\n  return a + b;\n}\n```');
});

test('user-prompt serialization restores list markers while preserving literal spaces', () => {
  const root = element('DIV', [element('P', [text('Keep "a  b".')]), element('OL', [
    element('LI', [text('Check input')]), element('LI', [text('Check overflow')]),
  ])]);
  assert.equal(serializeResponseText(root as unknown as Element, { preserveTextWhitespace: true }), 'Keep "a  b".\n\n1. Check input\n2. Check overflow');
});

test('Grok prompt code cards omit display-language and copy labels while preserving fenced code', () => {
  const code = element('PRE', [element('CODE', [text('const value = "a  b";\nconsole.log(value);')])], { class: 'language-javascript' });
  const card = element('DIV', [
    element('DIV', [text('JavaScript'), element('BUTTON', [text('Copy code')])]), code,
  ], { 'data-testid': 'code-block' });
  const root = element('DIV', [element('P', [text('Review this code:')]), card]);
  assert.equal(serializeResponseText(root as unknown as Element, {
    preserveTextWhitespace: true, codeBlockSelectors: ['[data-testid="code-block"]'],
  }), 'Review this code:\n\n```javascript\nconst value = "a  b";\nconsole.log(value);\n```');
});

test('Meta retains plain legacy answers and complete code blocks', () => {
  const legacy = element('DIV', [text('Plain legacy answer')]);
  assert.equal(isMetaResponseCandidate(legacy as unknown as Element), true);
  assert.equal(extractResponseContent(legacy as unknown as Element, metaResponseContentRoot), 'Plain legacy answer');
  const body = element('DIV', [
    element('P', [text('Implementation:')]),
    element('PRE', [element('CODE', [text('const add = (a, b) => a + b;')], { class: 'language-js' })]),
    element('P', [text('Usage: add(2, 3).')]),
  ], { class: 'ur-markdown' });
  assert.equal(extractResponseContent(body as unknown as Element, metaResponseContentRoot), 'Implementation:\n\n```js\nconst add = (a, b) => a + b;\n```\n\nUsage: add(2, 3).');
});

// serializeResponseText only touches nodeType / tagName / childNodes / textContent /
// getAttribute, so these few fields are enough — no DOM implementation needed.
function text(value: string) {
  return { nodeType: 3, textContent: value };
}

function element(tagName: string, childNodes: unknown[], attrs: Record<string, string> = {}) {
  const result = {
    nodeType: 1,
    tagName,
    childNodes,
    textContent: childNodes.map((child) => (child as { textContent: string }).textContent).join(''),
    getAttribute: (name: string) => attrs[name] ?? null,
    contains: (candidate: unknown): boolean => candidate === result || childNodes.some((child) => (
      child === candidate || Boolean((child as { contains?: (node: unknown) => boolean }).contains?.(candidate))
    )),
    matches: (selector: string) => selector.split(',').some((part) => {
      const candidate = part.trim();
      if (candidate === '.response-content-markdown') {
        return attrs.class?.split(/\s+/).includes('response-content-markdown');
      }
      if (candidate === '.ur-markdown') return attrs.class?.split(/\s+/).includes('ur-markdown');
      if (candidate === '[data-testid="thinking-status"]') return attrs['data-testid'] === 'thinking-status';
      if (candidate === '[data-testid="code-block"]') return attrs['data-testid'] === 'code-block';
      if (candidate === 'img[src*="/images/cot_logo_static/"]') return tagName === 'IMG' && attrs.src?.includes('/images/cot_logo_static/');
      if (candidate === '[data-streaming-state]') return Boolean(attrs['data-streaming-state']);
      return candidate.toUpperCase() === tagName;
    }),
    querySelector: (selector: string): unknown => {
      const visit = (node: unknown): unknown => {
        const candidate = node as ReturnType<typeof element>;
        if (candidate.matches?.(selector)) return candidate;
        for (const child of candidate.childNodes ?? []) {
          const match = visit(child);
          if (match) return match;
        }
        return null;
      };
      for (const child of childNodes) {
        const match = visit(child);
        if (match) return match;
      }
      return null;
    },
    querySelectorAll: (selector: string): unknown[] => {
      const found: unknown[] = [];
      const visit = (node: unknown) => {
        const candidate = node as ReturnType<typeof element>;
        if (candidate.matches?.(selector)) found.push(candidate);
        for (const child of candidate.childNodes ?? []) visit(child);
      };
      for (const child of childNodes) visit(child);
      return found;
    },
  };
  return result;
}
