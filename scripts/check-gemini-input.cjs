// Production content bundle + browser-native and controlled editor fixtures.
// No provider account/network; the Chrome profile is ephemeral and unauthenticated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const prompt = 'Answer in English.\n\nKeep "a  b" and x + y intact.\n日本語 中文 Kiswahili 👩‍💻\n```ts\nconst x = 1;\n```';
const scenarios = [
  { name: 'native multiline insertion without a paste handler', success: true },
  { name: 'delayed controlled input reconciliation', delay: 40, success: true },
  { name: 'unrelated existing draft', draft: 'Unrelated user draft', error: 'error.existing_draft' },
  { name: 'significant whitespace draft', draft: prompt.replace('a  b', 'a b'), error: 'error.existing_draft' },
  { name: 'whitespace-only draft preserved', draft: ' \n\t', error: 'error.input_injection_failed' },
  { name: 'rejected native edit', ignored: true, error: 'error.input_injection_failed' },
  { name: 'late editor rollback', rollback: true, error: 'error.existing_draft' },
  { name: 'disabled send', disabled: true, error: 'error.send_action_disabled' },
  { name: 'remounted composer after activation', remount: true, error: 'error.send_unconfirmed' },
  { name: 'draft clearing without response', clearOnly: true, error: 'error.send_unconfirmed' },
  { name: 'cancel during delayed reconciliation', delay: 120, cancel: true },
];

function installFixture(options) {
  const listeners = new Set();
  window.fixture = { events: [], edits: [], messages: [], clicks: 0, enters: 0, options };
  window.chrome = { runtime: {
    id: 'gemini-fixture',
    onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
    sendMessage: async message => { window.fixture.messages.push(message); },
  } };
  window.fixture.send = () => new Promise(resolve => {
    for (const listener of listeners) listener({ action: 'SEND_MESSAGE', provider: 'gemini', requestId: 'request', workflowId: 'workflow', payload: { text: options.prompt } }, {}, resolve);
  });
  window.fixture.stop = () => new Promise(resolve => {
    for (const listener of listeners) listener({ action: 'STOP_GENERATION', provider: 'gemini', requestId: 'request', workflowId: 'workflow' }, {}, resolve);
  });
  const editor = document.querySelector('rich-textarea .ql-editor');
  const commit = text => {
    window.fixture.modelText = text;
    editor.replaceChildren(...text.split('\n').map(line => {
      // Chrome's native contenteditable uses DIV lines. Preserve preformatted
      // spacing so the simulated model's innerText is not CSS-normalized.
      const lineElement = document.createElement('div');
      if (line) lineElement.textContent = line; else lineElement.append(document.createElement('br'));
      return lineElement;
    }));
  };
  commit(options.draft || '');
  // Observe synthetic paste without supplying a cooperative insertion handler.
  // The browser must perform the actual edit and emit its normal input events.
  editor.addEventListener('paste', () => window.fixture.events.push('paste'));
  const nativeExecCommand = document.execCommand.bind(document);
  document.execCommand = (command, showUI, value) => {
    window.fixture.edits.push({ command, value });
    if (options.ignored) return false;
    const result = nativeExecCommand(command, showUI, value);
    if (options.delay) {
      commit('');
      setTimeout(() => commit(value), options.delay);
    }
    if (options.rollback) setTimeout(() => commit('Reconciled old editor state'), 80);
    return result;
  };
  editor.addEventListener('input', event => {
    window.fixture.events.push(event.type);
    // This fixture's model stores one plain-text line per native block. innerText
    // adds an extra rendered break for an empty DIV/BR and is not that model.
    window.fixture.modelText = Array.from(editor.childNodes).map(line => line.textContent).join('\n');
  });
  editor.addEventListener('keydown', event => { if (event.key === 'Enter') window.fixture.enters++; });
  const send = document.querySelector('button.send-button');
  send.disabled = Boolean(options.disabled);
  send.addEventListener('click', () => {
    window.fixture.clicks++;
    window.fixture.acceptedText = window.fixture.modelText;
    window.fixture.acceptedRenderedText = editor.innerText;
    if (options.remount) {
      const replacement = editor.cloneNode(false); replacement.innerHTML = '<p><br></p>'; editor.replaceWith(replacement); return;
    }
    commit('');
    if (options.clearOnly) return;
    const response = document.createElement('div'); response.className = 'model-response-text';
    response.innerHTML = '<div class="markdown"><p>Synthetic English response.</p><button>Copy</button></div>';
    document.querySelector('#thread').append(response);
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.GEMINI_BROWSER });
  const report = { browser: browser.version(), evidence: 'Production Gemini content bundle + simulated Chrome transport + controlled DOM; no authenticated provider', passed: [] };
  try {
    for (const scenario of scenarios) {
      const context = await browser.newContext();
      try {
        await context.route('**/*', route => route.request().isNavigationRequest()
          ? route.fulfill({ contentType: 'text/html', body: '<style>[contenteditable]{min-height:40px;white-space:pre-wrap}button{min-height:25px}</style><div class="ql-editor" contenteditable="true" aria-label="Unrelated editor">Keep me</div><div class="ql-editor" contenteditable="true" style="display:none">Hidden draft</div><form><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button class="send-button" type="button">Send</button></form><div id="thread"></div>' })
          : route.abort());
        const page = await context.newPage();
        await page.goto('https://gemini.google.com/fixture');
        await page.evaluate(installFixture, { ...scenario, prompt });
        await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../dist/content/gemini.js'), 'utf8') });
        const sendPromise = page.evaluate(() => window.fixture.send());
        if (scenario.cancel) {
          await page.waitForFunction(() => window.fixture.edits.length > 0);
          await page.evaluate(() => window.fixture.stop());
        }
        const ack = await sendPromise;
        if (!scenario.cancel) await page.waitForFunction(() => window.fixture.messages.some(message => message.action === 'RESPONSE_DONE'), undefined, { timeout: 18000 });
        else await page.waitForTimeout(350);
        const state = await page.evaluate(() => ({
          ...window.fixture, messages: window.fixture.messages.filter(message => message.action === 'RESPONSE_DONE'),
          draft: window.fixture.modelText,
          renderedDraft: document.querySelector('rich-textarea .ql-editor').innerText,
          unrelated: document.querySelector('[aria-label="Unrelated editor"]').innerText,
        }));
        assert.equal(state.enters, 0, scenario.name);
        assert.equal(state.unrelated, 'Keep me');
        assert.ok(state.clicks <= 1, `${scenario.name}: must never repeat activation`);
        assert.ok(state.edits.length <= 1, `${scenario.name}: must never repeat insertion`);
        if (scenario.success) {
          assert.equal(ack.ok, true, `${scenario.name}: ${state.messages[0]?.payload || 'no acknowledgement'}`);
          assert.equal(state.clicks, 1, `${scenario.name}: ${state.messages[0]?.payload || 'no response'}`);
          assert.equal(state.acceptedText, prompt);
          assert.deepEqual(state.edits, [{ command: 'insertText', value: prompt }]);
          assert.ok(state.events.includes('input'), `${scenario.name}: native input observed`);
          assert.match(state.messages[0].payload, /Synthetic English response/);
        } else if (scenario.cancel) {
          assert.equal(state.clicks, 0); assert.equal(state.messages.length, 0);
        } else {
          assert.match(state.messages[0].payload, new RegExp(scenario.error));
          if (scenario.draft) {
            assert.equal(state.draft, scenario.draft); assert.equal(state.clicks, 0); assert.equal(state.edits.length, 0);
          } else if (scenario.ignored) {
            assert.equal(state.draft, ''); assert.equal(state.clicks, 0); assert.equal(state.edits.length, 1);
          } else if (scenario.rollback || scenario.disabled) {
            assert.equal(state.clicks, 0); assert.equal(state.edits.length, 1);
          } else if (scenario.remount || scenario.clearOnly) {
            assert.equal(state.clicks, 1); assert.equal(state.edits.length, 1);
          }
        }
        assert.equal(state.events.includes('paste'), false, `${scenario.name}: no synthetic paste fallback`);
        report.passed.push(scenario.name);
      } finally { await context.close(); }
    }
    console.log(JSON.stringify(report, null, 2));
    if (process.env.GEMINI_OUTPUT) fs.writeFileSync(process.env.GEMINI_OUTPUT, JSON.stringify(report, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
