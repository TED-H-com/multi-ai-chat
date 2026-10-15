// Optional DOM integration check. Uses the production panel with a Chrome API
// double in an isolated browser context; never runs against a provider account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const origin = 'https://readiness.test';
const providers = ['chatgpt', 'claude', 'gemini', 'grok', 'meta'];
const output = path.resolve(process.env.READINESS_OUTPUT || '/tmp/multi-ai-readiness-ui');
const states = (ready) => Object.fromEntries(providers.map(provider => [provider, {
  provider, status: ready.includes(provider) ? 'connected' : 'disconnected',
}]));

function installChromeDouble({ seed, initialConnections }) {
  const key = 'readiness-fixture-storage';
  const read = () => JSON.parse(localStorage.getItem(key) || JSON.stringify(seed));
  const write = (values) => localStorage.setItem(key, JSON.stringify({ ...read(), ...values }));
  const listeners = new Set();
  const permissionAdded = new Set();
  const permissionRemoved = new Set();
  let pending = [];
  let pendingStorage = [];
  const storageCall = (method, keys, perform) => {
    const fixture = window.readinessFixture;
    fixture.storageCalls.push({ method, keys }); // Metadata only; never record token values.
    const hold = fixture.storageHold;
    if (hold?.method === method && keys.includes(hold.key)) {
      return new Promise((resolve, reject) => pendingStorage.push({ resolve, reject, perform }));
    }
    return Promise.resolve().then(perform);
  };
  const pendingRecovery = JSON.parse(localStorage.getItem('readiness-fixture-recovery') || 'null');
  window.readinessFixture = {
    connections: initialConnections, requests: [], scope: undefined,
    allowSend: false, sent: [],
    pendingRecovery, presentedRecoveries: [], recoveryDecisions: [], emitted: [],
    storageCalls: [], storageHold: null,
    metaHostGranted: false, permissionRequests: [], grantPermissionRequest: false,
    pendingStorageCount: () => pendingStorage.length,
    releaseStorage(fail = false) {
      this.storageHold = null;
      const batch = pendingStorage;
      pendingStorage = [];
      for (const operation of batch) {
        if (fail) operation.reject(new Error('Simulated storage failure'));
        else operation.resolve(operation.perform());
      }
    },
    emit(message, sender = {}) { this.emitted.push(message); for (const listener of listeners) listener(message, sender); },
    emitPermissions(event, changed = {}) {
      const set = event === 'onAdded' ? permissionAdded : event === 'onRemoved' ? permissionRemoved : undefined;
      if (!set) throw new Error(`Unexpected permission event: ${event}`);
      for (const listener of set) listener(changed);
    },
    setConnections(connections) {
      this.connections = connections;
      this.emit({ action: 'CONNECTIONS_UPDATE', payload: connections });
    },
    finishOpening(failures = []) {
      const batch = pending;
      pending = [];
      for (const { provider, resolve } of batch) resolve(failures.includes(provider)
        ? { ok: false, error: 'Simulated tab open failure' } : { ok: true });
    },
    workflow(done = false) {
      this.emit({ action: 'WORKFLOW_STATUS', payload: {
        ...this.scope, workflowId: 'readiness-fixture-workflow',
        key: done ? '' : 'workflow.starting', done, cancelled: done,
      } });
    },
    stored: read,
  };
  window.chrome = {
    storage: { local: {
      get(keys, callback) {
        const values = read();
        const names = Array.isArray(keys) ? keys : [keys];
        const result = Object.fromEntries(names.map(key => [key, values[key]]));
        const request = storageCall('get', names, () => result);
        if (callback) void request.then(callback);
        return request;
      },
      set(values) { return storageCall('set', Object.keys(values), () => write(values)); },
      remove(key) { return storageCall('remove', [key], () => { const values = read(); delete values[key]; localStorage.setItem('readiness-fixture-storage', JSON.stringify(values)); }); },
    } },
    runtime: {
      onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
      connect: () => ({ onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
      sendMessage(message, callback) {
        const fixture = window.readinessFixture;
        fixture.requests.push({ action: message.action, provider: message.provider });
        let result;
        if (message.action === 'GET_CONNECTIONS') {
          fixture.scope = message.payload;
          result = fixture.connections;
          if (fixture.pendingRecovery) {
            const recovery = fixture.pendingRecovery;
            queueMicrotask(() => fixture.emit({
              action: 'STEP_RECOVERY_REQUIRED',
              provider: recovery.provider,
              requestId: recovery.failedRequestId,
              workflowId: recovery.workflowId,
              payload: { ...recovery, clientId: message.payload.clientId, sessionId: message.payload.sessionId },
            }));
          }
        } else if (message.action === 'OPEN_LOGIN') {
          return new Promise(resolve => pending.push({ provider: message.provider, resolve }));
        } else if (message.action === 'GET_PROVIDER_URLS') result = {};
        else if (message.action === 'STEP_RECOVERY_PRESENTED') {
          fixture.presentedRecoveries.push(message.payload);
          result = { ok: true };
        } else if (message.action === 'RESOLVE_STEP_RECOVERY') {
          fixture.recoveryDecisions.push(message.payload);
          result = { ok: true };
        }
        else if (message.action === 'SEND_MESSAGE' && fixture.allowSend) {
          fixture.sent.push(message.payload);
          result = { ok: true }; // Sink only: no worker, provider tab or network request.
        } else throw new Error(`Unexpected runtime action: ${message.action}`);
        if (callback) queueMicrotask(() => callback(result));
        return Promise.resolve(result);
      },
    },
    permissions: {
      onAdded: {
        addListener: listener => permissionAdded.add(listener),
        removeListener: listener => permissionAdded.delete(listener),
      },
      onRemoved: {
        addListener: listener => permissionRemoved.add(listener),
        removeListener: listener => permissionRemoved.delete(listener),
      },
      contains() {
        return Promise.resolve(Boolean(window.readinessFixture.metaHostGranted));
      },
      // Origins only. A user grant is simulated only when grantPermissionRequest is set.
      request(details) {
        const fixture = window.readinessFixture;
        const origins = Array.isArray(details?.origins) ? [...details.origins] : [];
        fixture.permissionRequests.push({ origins });
        if (!fixture.grantPermissionRequest) return Promise.resolve(false);
        fixture.metaHostGranted = true;
        for (const listener of permissionAdded) listener({ origins });
        return Promise.resolve(true);
      },
    },
  };
}

async function run(browser) {
  const { t, SUPPORTED_LOCALES } = await import(pathToFileURL(path.join(root, 'src/shared/i18n.ts')));
  fs.mkdirSync(output, { recursive: true });
  const report = {
    status: 'RUNNING', recordedAt: new Date().toISOString(),
    evidence: 'Production dist DOM + simulated Chrome runtime/storage. Not an installed extension or authenticated VM pass.',
    checkoutCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    bundleSHA256: createHash('sha256').update(fs.readFileSync(path.join(root, 'dist/sidepanel.js'))).digest('hex'),
    browser: browser.version(), vmResult: 'NOT_RUN: this runner uses simulated Chrome APIs',
    locales: [], errors: [],
  };
  const saveReport = () => fs.writeFileSync(path.join(output, 'RESULTS.json'), JSON.stringify(report, null, 2) + '\n');
  saveReport();
  const fixtureLocales = process.env.READINESS_LOCALES
    ? SUPPORTED_LOCALES.filter((locale) => process.env.READINESS_LOCALES.split(',').includes(locale))
    : SUPPORTED_LOCALES;
  assert.ok(fixtureLocales.length > 0, 'READINESS_LOCALES must name at least one supported locale');
  for (const language of fixtureLocales) {
    const context = await browser.newContext({ viewport: { width: 420, height: 850 } });
    const passed = [];
    report.locales.push({ language, passed });
    try {
      const assets = {
        '/sidepanel.html': ['text/html', 'sidepanel.html'],
        '/sidepanel.js': ['application/javascript', 'sidepanel.js'],
        '/sidepanel.css': ['text/css', 'sidepanel.css'],
      };
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        const asset = url.origin === origin && assets[url.pathname];
        return asset ? route.fulfill({ contentType: asset[0], body: fs.readFileSync(path.join(root, 'dist', asset[1])) }) : route.abort();
      });
      await context.addInitScript(installChromeDouble, {
        seed: { language, standbyProvider: 'grok', freeTargets: ['chatgpt', 'claude', 'gemini', 'meta'] },
        initialConnections: states(['meta', 'grok']), // Ready standby must remain excluded.
      });
      const createPanel = async () => {
        const page = await context.newPage();
        page.on('pageerror', error => report.errors.push(`${language}: ${error.message}`));
        await page.goto(`${origin}/sidepanel.html`);
        await page.waitForFunction(() => window.readinessFixture.scope);
        return page;
      };
      let page = await createPanel();
      const label = key => t(key, undefined, language);
      const button = key => page.getByRole('button', { name: label(key), exact: true });
      const expectPrompt = async (state, snapshot) => {
        const prompt = page.getByRole('textbox', { name: label('input.label'), exact: true });
        assert.equal(await prompt.count(), 1, `${language}: prompt name must remain stable when ${snapshot}`);
        assert.equal(await prompt.isDisabled(), state !== 'ready');
        const placeholderKey = state === 'ready' ? 'input.placeholder'
          : state === 'running' ? 'input.placeholder.processing' : 'input.placeholder.connect';
        assert.equal(await prompt.getAttribute('placeholder'), label(placeholderKey));
        const hasNotice = await page.locator('#input-readiness').count() > 0;
        assert.equal(await prompt.getAttribute('aria-describedby'), hasNotice ? 'input-readiness' : null);
        fs.writeFileSync(path.join(output, `${language}-prompt-${snapshot}.aria.txt`), await prompt.ariaSnapshot());
      };
      const modeGroup = () => page.getByRole('group', { name: label('mode.selector'), exact: true });
      const mode = name => modeGroup().getByRole('button', { name: label(`mode.${name}`), exact: true });
      const expectMode = async name => {
        await modeGroup().getByRole('button', { name: label(`mode.${name}`), exact: true, pressed: true }).waitFor();
        assert.equal(await modeGroup().getByRole('button', { pressed: true }).count(), 1);
        assert.equal(await modeGroup().getByRole('button', { pressed: false }).count(), 4);
      };
      const expectNotice = async text => page.waitForFunction(text => document.querySelector('#input-readiness')?.textContent === text, text);
      const expectSelected = async names => page.waitForFunction(({ names, groupName }) => {
        const group = [...document.querySelectorAll('[role="group"]')].find(group => group.getAttribute('aria-label') === groupName);
        return group && JSON.stringify([...group.querySelectorAll('button[aria-pressed="true"]')].map(button => button.textContent)) === JSON.stringify(names);
      }, { names, groupName: label('targets.title') });
      await expectNotice(t('input.readiness.partial', { ready: 'Meta AI', providers: 'ChatGPT · Claude · Gemini' }, language));
      assert.equal(await page.locator('textarea').isEnabled(), true);
      assert.notEqual(label('input.label'), 'input.label');
      if (language !== 'en') assert.notEqual(label('input.label'), t('input.label', undefined, 'en'));
      await expectPrompt('ready', 'partial');
      const settings = () => page.getByRole('dialog', { name: label('settings.title'), exact: true });
      const focused = locator => locator.evaluate(element => element === document.activeElement);
      const expectSettingsClosed = async () => {
        await settings().waitFor({ state: 'detached' });
        assert.equal(await focused(button('app.settings')), true, `${language}: Settings must restore focus to its opener`);
      };
      await page.setViewportSize({ width: 320, height: 600 });
      await button('app.settings').focus();
      await page.keyboard.press('Enter');
      await settings().waitFor();
      const closeSettings = () => settings().getByRole('button', { name: label('app.close'), exact: true });
      const saveSettings = () => settings().getByRole('button', { name: label('settings.save'), exact: true });
      const tokenReady = () => page.waitForFunction(() => {
        const input = document.querySelector('#hackmd-token');
        return input && !input.disabled;
      });
      await tokenReady();
      assert.equal(await focused(closeSettings()), true, `${language}: Settings must initially focus Close`);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focused(saveSettings()), true, `${language}: reverse Tab must wrap inside Settings`);
      const saveBounds = await saveSettings().boundingBox();
      assert.ok(saveBounds && saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 600);
      await page.keyboard.press('Tab');
      assert.equal(await focused(closeSettings()), true, `${language}: Tab must wrap inside Settings`);
      await page.keyboard.press('Tab');
      assert.equal(await focused(settings().locator('#language-select')), true);
      await settings().locator('#hackmd-token').fill('unsaved fixture text');
      // A provider-status rerender must not restart focus management while editing.
      await page.evaluate(connections => window.readinessFixture.setConnections(connections), states(['meta', 'grok']));
      assert.equal(await focused(settings().locator('#hackmd-token')), true);
      for (const event of [{ isComposing: true, keyCode: 27 }, { isComposing: false, keyCode: 229 }]) {
        const allowed = await settings().locator('#hackmd-token').evaluate((input, event) => input.dispatchEvent(new KeyboardEvent('keydown', {
          ...event, key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
        })), event);
        assert.equal(allowed, true, `${language}: composition Escape must remain available to the editor`);
        assert.equal(await settings().count(), 1);
      }
      await page.keyboard.press('Escape');
      await expectSettingsClosed();
      assert.equal(await page.evaluate(() => window.readinessFixture.stored().hackmd_token), undefined);
      for (const action of ['close', 'cancel', 'backdrop', 'save']) {
        await page.keyboard.press('Enter');
        await settings().waitFor();
        await tokenReady();
        assert.equal(await focused(closeSettings()), true);
        await page.waitForFunction(() => document.querySelector('#hackmd-token')?.value === '');
        if (action === 'close') await closeSettings().click();
        else if (action === 'cancel') await settings().getByRole('button', { name: label('settings.cancel'), exact: true }).click();
        else if (action === 'backdrop') await page.mouse.click(2, 2);
        else await saveSettings().click();
        await expectSettingsClosed();
      }
      await page.setViewportSize({ width: 420, height: 850 });
      passed.push('Settings moves focus inside, wraps Tab both ways, preserves editing focus on status updates, ignores IME Escape, and restores the opener after Escape/Close/Cancel/backdrop/Save');
      await page.keyboard.press('Enter');
      await settings().waitFor();
      await tokenReady();
      await saveSettings().click();
      await settings().getByRole('button', { name: label('settings.saved'), exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await expectSettingsClosed();
      await page.keyboard.press('Enter');
      await settings().waitFor();
      await page.waitForTimeout(650); // Cross the previous save's 500ms close deadline.
      assert.equal(await settings().count(), 1, `${language}: an old save must not close newly reopened Settings`);
      await page.keyboard.press('Escape');
      await expectSettingsClosed();
      passed.push('Completed save followed by immediate dismissal/reopen cannot close the new Settings session');
      const openSettings = async () => {
        await button('app.settings').click();
        await settings().waitFor();
      };
      const holdStorage = (method, key = 'hackmd_token') => page.evaluate(hold => {
        window.readinessFixture.storageHold = hold;
      }, { method, key });
      const storagePending = () => page.waitForFunction(() => window.readinessFixture.pendingStorageCount() === 1);
      const releaseStorage = (fail = false) => page.evaluate(async fail => {
        window.readinessFixture.releaseStorage(fail);
        await new Promise(requestAnimationFrame);
      }, fail);
      const clearSettingsToken = () => settings().getByRole('button', { name: label('settings.clear'), exact: true });
      for (const key of ['settings.token_loading', 'settings.token_load_failed', 'settings.save_failed', 'settings.clear_failed', 'settings.saved']) {
        assert.notEqual(label(key), key);
        if (language !== 'en') assert.notEqual(label(key), t(key, undefined, 'en'));
      }
      await page.evaluate(() => chrome.storage.local.set({ hackmd_token: 'fixture-original' }));
      await holdStorage('get');
      await openSettings();
      await storagePending();
      assert.equal(await settings().locator('#hackmd-token').isDisabled(), true);
      assert.equal(await saveSettings().isDisabled(), true);
      assert.equal(await clearSettingsToken().isDisabled(), true);
      assert.equal(await settings().getByRole('status').innerText(), label('settings.token_loading'));
      await page.keyboard.press('Escape');
      await expectSettingsClosed();
      // Let a new read finish before delivering the old session's captured read result.
      await page.evaluate(() => { window.readinessFixture.storageHold = null; });
      await openSettings();
      await tokenReady();
      await settings().locator('#hackmd-token').fill('new-session-draft');
      await releaseStorage();
      assert.equal(await settings().locator('#hackmd-token').inputValue(), 'new-session-draft');
      await page.keyboard.press('Escape');
      await expectSettingsClosed();
      passed.push('Loading disables token mutations; a stale read cannot replace the reopened dialog draft');

      await page.setViewportSize({ width: 320, height: 600 });
      for (const fail of [false, true]) {
        const previous = await page.evaluate(() => window.readinessFixture.stored().hackmd_token);
        await openSettings();
        await tokenReady();
        const draft = `fixture-pending-save-${fail}`;
        await settings().locator('#hackmd-token').fill(draft);
        await holdStorage('set');
        const writes = () => page.evaluate(() => window.readinessFixture.storageCalls.filter(call => call.method === 'set' && call.keys.includes('hackmd_token')).length);
        const before = await writes();
        await saveSettings().click();
        await saveSettings().evaluate(button => button.click());
        await storagePending();
        const focusVisible = await page.evaluate(() => {
          const bounds = document.activeElement.getBoundingClientRect();
          return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
        });
        assert.equal(focusVisible, true, `${language}: focus must stay visible while Save is pending in a short panel`);
        assert.equal(await writes(), before + 1, 'Repeated Save must issue only one token write');
        assert.equal(await saveSettings().isDisabled(), true);
        assert.equal(await clearSettingsToken().isDisabled(), true);
        assert.equal(await settings().locator('#language-select').isDisabled(), true);
        await page.keyboard.press('Escape');
        await expectSettingsClosed();
        await openSettings();
        assert.equal(await settings().locator('#hackmd-token').isDisabled(), true, 'Reopening waits for the previous write before reading');
        assert.equal(await settings().locator('#language-select').isDisabled(), true, 'An old save must finish before the reopened dialog changes language');
        await releaseStorage(fail);
        await tokenReady();
        assert.equal(await settings().locator('#hackmd-token').inputValue(), fail ? previous : draft);
        assert.equal(await settings().getByRole('alert').count(), 0, 'Old write failures must not appear in the new session');
        await settings().locator('#hackmd-token').fill('draft-after-old-save');
        await page.waitForTimeout(650); // A late save completion must not schedule a new close.
        assert.equal(await settings().count(), 1);
        assert.equal(await settings().locator('#hackmd-token').inputValue(), 'draft-after-old-save');
        await page.keyboard.press('Escape');
        await expectSettingsClosed();
      }
      await openSettings();
      await tokenReady();
      await holdStorage('remove');
      await clearSettingsToken().click();
      await storagePending();
      await page.keyboard.press('Escape');
      await expectSettingsClosed();
      await openSettings();
      assert.equal(await saveSettings().isDisabled(), true);
      await releaseStorage();
      await tokenReady();
      assert.equal(await settings().locator('#hackmd-token').inputValue(), '');
      await page.keyboard.press('Escape');
      await expectSettingsClosed();
      passed.push('Pending Save/Clear survive dismissal without affecting a later session; duplicate Save is blocked and reopening reads the completed write');

      await holdStorage('get');
      await openSettings();
      await storagePending();
      await releaseStorage(true);
      assert.equal(await settings().getByRole('alert').innerText(), label('settings.token_load_failed'));
      assert.equal(await saveSettings().isDisabled(), true);
      await settings().getByRole('button', { name: label('recovery.retry'), exact: true }).click();
      await tokenReady();
      assert.equal(await settings().getByRole('alert').count(), 0);
      for (const key of ['hackmd_token', 'language']) {
        await settings().locator('#hackmd-token').fill('fixture-retry-draft');
        await holdStorage('set', key);
        await saveSettings().click();
        await storagePending();
        await releaseStorage(true);
        await tokenReady();
        assert.equal(await settings().getByRole('alert').innerText(), label('settings.save_failed'));
        assert.equal(await settings().locator('#hackmd-token').inputValue(), 'fixture-retry-draft');
        await saveSettings().click();
        await expectSettingsClosed();
        await openSettings();
        await tokenReady();
      }
      await holdStorage('remove');
      await clearSettingsToken().click();
      await storagePending();
      await releaseStorage(true);
      await tokenReady();
      assert.equal(await settings().getByRole('alert').innerText(), label('settings.clear_failed'));
      assert.equal(await settings().locator('#hackmd-token').inputValue(), 'fixture-retry-draft');
      await clearSettingsToken().click();
      await tokenReady();
      assert.equal(await settings().locator('#hackmd-token').inputValue(), '');
      assert.equal(await settings().getByRole('alert').count(), 0);
      await page.keyboard.press('Escape');
      await expectSettingsClosed();
      passed.push('Load, token/language save and Clear failures show localized errors, preserve editable drafts where loaded, and allow a successful retry');
      assert.notEqual(label('mode.selector'), 'mode.selector');
      if (language !== 'en') assert.notEqual(label('mode.selector'), t('mode.selector', undefined, 'en'));
      await expectMode('free');
      await page.setViewportSize({ width: 320, height: 600 });
      await mode('free').focus();
      for (const [name, key] of [['debate', 'Enter'], ['consult', 'Space'], ['coding', 'Enter'], ['roundtable', 'Space']]) {
        await page.keyboard.press('Tab');
        assert.equal(await mode(name).evaluate(button => button === document.activeElement), true);
        await page.keyboard.press(key);
        await expectMode(name);
        await page.waitForFunction(() => {
          const button = document.activeElement;
          if (!button?.parentElement || button.getAttribute('aria-pressed') !== 'true') return false;
          const bounds = button.getBoundingClientRect();
          const group = button.parentElement.getBoundingClientRect();
          return bounds.left >= group.left && bounds.right <= group.right;
        }, undefined, { timeout: 2000 });
        const bounds = await mode(name).boundingBox();
        const group = await modeGroup().boundingBox();
        await page.screenshot({ path: path.join(output, `${language}-mode-${name}.png`) });
        assert.ok(bounds && group && bounds.x >= group.x && bounds.x + bounds.width <= group.x + group.width,
          `${language}: focused ${name} mode must scroll into view in a narrow panel; button=${JSON.stringify(bounds)} group=${JSON.stringify(group)}`);
      }
      await mode('free').focus();
      await page.keyboard.press('Enter');
      await expectMode('free');
      fs.writeFileSync(path.join(output, `${language}-modes.aria.txt`), await modeGroup().ariaSnapshot());
      await page.setViewportSize({ width: 420, height: 850 });
      passed.push('Localized mode group exposes exactly one pressed mode; Tab plus Enter/Space switches all modes and reveals focused buttons in a narrow panel');
      for (const name of ['debate', 'consult']) {
        await mode(name).click();
        await expectMode(name);
        await expectNotice(t('error.providers_not_ready', { providers: 'ChatGPT · Claude · Gemini' }, language));
        assert.equal(await page.locator('textarea').isDisabled(), true);
        await expectPrompt('blocked', name);
        assert.equal(await button('connection.open_unready').isEnabled(), true);
        assert.equal(await button('targets.select_ready').count(), 0);
      }
      passed.push('Free partial and Debate/Consult blockers name only the three unready active providers');
      await mode('free').click();
      await button('connection.open_unready').click();
      assert.equal(await button('connection.opening').isDisabled(), true);
      const opened = () => page.evaluate(() => window.readinessFixture.requests.filter(r => r.action === 'OPEN_LOGIN').map(r => r.provider));
      assert.deepEqual(await opened(), ['chatgpt', 'claude', 'gemini']);
      await page.evaluate(() => window.readinessFixture.finishOpening(['claude']));
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByRole('alert').innerText(), t('error.open_unready_failed', { providers: 'Claude' }, language));
      const draft = Array.from({ length: 10 }, (_, index) => `Draft line ${index + 1}`).join('\n');
      await page.locator('textarea').fill(draft);
      for (const viewport of [{ width: 320, height: 600 }, { width: 420, height: 600 }]) {
        await page.setViewportSize(viewport);
        await page.screenshot({ path: path.join(output, `${language}-draft-error-${viewport.width}.png`) });
        const bounds = await button('input.send').boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
          `${language}: Send with multiline draft and open failure must fit ${viewport.width}x${viewport.height}; bounds=${JSON.stringify(bounds)}`);
        assert.equal(await page.locator('textarea').inputValue(), draft);
        assert.equal(await button('input.send').isEnabled(), true);
        await button('targets.select_ready').scrollIntoViewIfNeeded();
        const shortcut = await button('targets.select_ready').boundingBox();
        const controls = await page.locator('section').boundingBox();
        assert.ok(shortcut && controls && shortcut.y >= controls.y && shortcut.y + shortcut.height <= controls.y + controls.height,
          `${language}: Ready-only shortcut must remain reachable by scrolling the controls`);
      }
      passed.push('Multiline draft and tab-open error keep Send visible in short panels without changing the draft');
      await page.locator('textarea').fill('');
      await page.setViewportSize({ width: 420, height: 850 });
      await button('connection.open_unready').click();
      assert.deepEqual(await opened(), ['chatgpt', 'claude', 'gemini', 'chatgpt', 'claude', 'gemini']);
      await page.evaluate(() => window.readinessFixture.finishOpening());
      await button('connection.open_unready').waitFor();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      await expectNotice(t('input.readiness.partial', { ready: 'Meta AI', providers: 'ChatGPT · Claude · Gemini' }, language));
      passed.push('Open shortcut sends exact OPEN_LOGIN requests, stays disabled pending, reports/retries individual failure without claiming Ready');
      for (const viewport of [{ width: 320, height: 600 }, { width: 420, height: 850 }]) {
        await page.setViewportSize(viewport);
        const bounds = await button('input.send').boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, `${language}: Send must fit ${viewport.width}x${viewport.height}`);
      }
      passed.push('Send remains fully visible with the unreadiness hint at 320x600 and 420x850');
      if (language === 'zh-TW') await page.screenshot({ path: path.join(output, 'zh-TW-partial.png') });
      await button('targets.select_ready').click();
      await expectSelected(['Meta AI']);
      await page.locator('#input-readiness').waitFor({ state: 'detached' });
      assert.equal(await button('connection.open_unready').count(), 0);
      await page.waitForFunction(() => JSON.stringify(window.readinessFixture.stored().freeTargets) === '["meta"]');
      // Destroy the entire page/React tree, then hydrate a fresh page from saved storage.
      await page.close();
      page = await createPanel();
      await expectMode('free');
      assert.equal(await button('targets.select_ready').count(), 1, `Reopen mode: ${await page.evaluate(() => JSON.stringify(window.readinessFixture.stored().conversations?.map(c => c.mode)))}`);
      await expectSelected(['Meta AI']);
      assert.equal(await page.locator('#input-readiness').count(), 0);
      await expectPrompt('ready', 'reopened');
      passed.push('Ready-only selects Meta, excludes Ready standby Grok, clears hint, and survives actual page close/reopen');
      if (language === 'zh-TW') await page.screenshot({ path: path.join(output, 'zh-TW-reopened.png') });
      await page.evaluate(connections => window.readinessFixture.setConnections(connections), states(['chatgpt', 'meta', 'grok']));
      await expectSelected(['Meta AI']);
      await button('targets.select_ready').click();
      await expectSelected(['ChatGPT', 'Meta AI']);
      await page.evaluate(connections => window.readinessFixture.setConnections(connections), states([]));
      await page.waitForFunction(() => document.querySelector('textarea').disabled);
      await expectPrompt('blocked', 'none-ready');
      assert.equal(await button('targets.select_ready').isDisabled(), true);
      assert.equal(await modeGroup().getByRole('button', { disabled: false }).count(), 5);
      await expectMode('free');
      await expectSelected(['ChatGPT', 'Meta AI']);
      await page.evaluate(connections => window.readinessFixture.setConnections(connections), states(providers));
      await page.waitForFunction(() => !document.querySelector('textarea').disabled);
      await page.locator('textarea').fill(draft);
      await expectPrompt('ready', 'filled');
      await page.evaluate(() => window.readinessFixture.workflow());
      await page.waitForFunction(() => document.querySelector('textarea').disabled);
      await expectPrompt('running', 'running');
      await button('app.settings').click();
      await settings().waitFor();
      await tokenReady();
      assert.equal(await settings().locator('#standby-provider').isDisabled(), true);
      await settings().locator('#theme-select').focus();
      await page.keyboard.press('Tab');
      assert.equal(await focused(settings().locator('#hackmd-token')), true, `${language}: Tab must skip the disabled standby selector`);
      await page.keyboard.press('Escape');
      await expectSettingsClosed();
      assert.equal(await button('targets.select_ready').isDisabled(), true);
      assert.equal(await modeGroup().getByRole('button', { disabled: true }).count(), 5);
      await expectMode('free');
      for (const viewport of [{ width: 320, height: 480 }, { width: 420, height: 600 }]) {
        await page.setViewportSize(viewport);
        const bounds = await button('input.stop').boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
          `${language}: Stop with multiline draft must fit ${viewport.width}x${viewport.height}`);
        assert.equal(await button('input.stop').isEnabled(), true);
        assert.equal(await page.locator('textarea').inputValue(), draft);
      }
      passed.push('Stop remains visible and enabled during a workflow with a multiline draft at 320x480 and 420x600');
      await page.setViewportSize({ width: 420, height: 850 });
      await page.evaluate(() => window.readinessFixture.workflow(true));
      await page.waitForFunction(() => !document.querySelector('textarea').disabled);
      await expectPrompt('ready', 'finished');
      passed.push('Prompt keeps its localized accessible name across partial/blocked/Ready/running states, entered text and reopening, with the correct placeholder and readiness description reference');
      passed.push('Readiness changes do not silently change selection; zero Ready and active workflow disable shortcut');
      const requests = await page.evaluate(() => window.readinessFixture.requests);
      assert.equal(requests.some(request => request.action === 'SEND_MESSAGE'), false);
      await page.evaluate(() => { window.readinessFixture.allowSend = true; });
      const composedDraft = '輸入法確認 日本語 한국어';
      await page.locator('textarea').fill(composedDraft);
      for (const event of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
        const allowed = await page.locator('textarea').evaluate((input, event) => input.dispatchEvent(new KeyboardEvent('keydown', {
          ...event, key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        })), event);
        assert.equal(await page.evaluate(() => window.readinessFixture.sent.length), 0, `${language}: IME confirmation must not send`);
        assert.equal(allowed, true, `${language}: IME confirmation must not prevent the editor's default action`);
        assert.equal(await page.locator('textarea').inputValue(), composedDraft, `${language}: IME confirmation must preserve the draft`);
      }
      await page.locator('textarea').press('End');
      await page.locator('textarea').press('Shift+Enter');
      assert.equal(await page.locator('textarea').inputValue(), `${composedDraft}\n`);
      assert.equal(await page.evaluate(() => window.readinessFixture.sent.length), 0);
      await page.locator('textarea').press('Enter');
      await page.waitForFunction(() => window.readinessFixture.sent.length === 1 && document.querySelector('textarea').disabled);
      const sent = await page.evaluate(() => window.readinessFixture.sent);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].text, composedDraft);
      assert.deepEqual(sent[0].targets, ['chatgpt', 'meta']);
      assert.equal(await page.locator('textarea').inputValue(), '');
      passed.push('Simulated IME confirmation preserves the draft without sending; Shift+Enter adds a newline and plain Enter sends exactly once to the selected targets');

      const newChat = async () => {
        const previous = await page.evaluate(() => window.readinessFixture.scope.sessionId);
        await button('app.menu').click();
        await page.getByRole('button', { name: `＋ ${label('app.new')}`, exact: true }).click();
        await page.waitForFunction(previous => window.readinessFixture.scope.sessionId !== previous, previous);
      };
      const savedCurrent = () => page.evaluate(() => {
        const stored = window.readinessFixture.stored();
        return stored.conversations?.find(conversation => conversation.id === stored.activeConversationId);
      });
      await page.evaluate(() => {
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (message, callback) => {
          if (message.action === 'GET_PROVIDER_URLS') return new Promise(resolve => {
            window.readinessFixture.releaseUrls = () => resolve({ meta: 'https://www.meta.ai/prompt/previous-fixture-conversation' });
          });
          if (message.action === 'RESET_PROVIDER_SESSIONS' || message.action === 'CANCEL_WORKFLOW') return Promise.resolve({ ok: true });
          return send(message, callback);
        };
        const scope = window.readinessFixture.sent.at(-1);
        window.readinessFixture.emit({ action: 'WORKFLOW_STATUS', payload: { ...scope, key: '', done: true } });
      });
      await page.waitForFunction(() => Boolean(window.readinessFixture.releaseUrls));
      await newChat();
      await page.evaluate(() => window.readinessFixture.releaseUrls());
      await page.waitForTimeout(500); // Allow React and the existing 350ms autosave to settle.
      const afterUrls = await savedCurrent();
      assert.equal(afterUrls?.providerUrls?.meta, undefined, `${language}: previous workflow URLs must not attach to a new conversation`);
      assert.deepEqual(afterUrls?.messages, []);
      passed.push('Delayed provider URLs from a completed workflow cannot pollute a newly selected conversation');

      await page.evaluate(() => {
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (message, callback) => {
          if (message.action === 'SEND_MESSAGE') {
            window.readinessFixture.sent.push(message.payload);
            return new Promise((resolve, reject) => {
              window.readinessFixture.rejectSend = () => reject(new Error('Simulated delayed send failure'));
            });
          }
          return send(message, callback);
        };
      });
      await page.locator('textarea').fill('Delayed failure fixture');
      await page.locator('textarea').press('Enter');
      await button('input.stop').click();
      await newChat();
      await page.evaluate(() => window.readinessFixture.rejectSend());
      await page.waitForTimeout(500);
      assert.deepEqual((await savedCurrent())?.messages, [], `${language}: cancelled send failure must not appear in a new conversation`);
      assert.equal(await page.locator('textarea').isEnabled(), true);
      // A failure of the current request must still be shown and release processing.
      await page.locator('textarea').fill('Current failure fixture');
      await page.locator('textarea').press('Enter');
      await page.evaluate(() => window.readinessFixture.rejectSend());
      await page.getByText('⚠️ Error: Simulated delayed send failure', { exact: true }).waitFor();
      assert.equal(await page.locator('textarea').isEnabled(), true);
      passed.push('Cancelled request failures cannot alter a new conversation, while the current request failure remains visible');

      await newChat();
      await page.evaluate(() => {
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (message, callback) => {
          if (message.action === 'SEND_MESSAGE') {
            window.readinessFixture.sent.push(message.payload);
            return Promise.resolve({ ok: true });
          }
          return send(message, callback);
        };
      });
      await page.locator('textarea').fill('Please answer in English. Quoted source: 中文資料。');
      await page.locator('textarea').press('Enter');
      await page.evaluate(() => {
        const scope = window.readinessFixture.sent.at(-1);
        const response = { action: 'RESPONSE_DONE', provider: 'meta', requestId: 'fixture-language-response', workflowId: scope.workflowId };
        window.readinessFixture.emit({ ...response, payload: 'Untrusted provider injection' }, { tab: { id: 99 } });
        window.readinessFixture.emit({ ...response, payload: 'Verified English answer' });
        window.readinessFixture.emit({ ...response, payload: 'Duplicate overwrites the answer' });
        window.readinessFixture.emit({ ...response, action: 'RESPONSE_CHUNK', payload: 'Late streaming chunk' });
        window.readinessFixture.emit({ action: 'WORKFLOW_STATUS', payload: { ...scope, key: '', done: true } });
      });
      await page.getByText('Verified English answer', { exact: true }).waitFor();
      assert.equal(await page.getByText('Untrusted provider injection', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Duplicate overwrites the answer', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Late streaming chunk', { exact: true }).count(), 0);
      await page.locator('textarea').fill('Continue with the implementation.');
      await page.locator('textarea').press('Enter');
      const followup = await page.evaluate(() => window.readinessFixture.sent.at(-1));
      assert.match(followup.context, /Please answer in English/);
      assert.match(followup.context, /中文資料/);
      assert.doesNotMatch(followup.context, /Verified English answer|Duplicate overwrites|Untrusted provider/);
      passed.push('Only worker responses are rendered; duplicate final and late chunks cannot replace a completed answer; normal follow-up retains user language preferences independently of UI locale');

      await button('input.stop').click();
      await newChat();
      await page.evaluate(() => {
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (message, callback) => message.action === 'SEND_MESSAGE'
          ? Promise.resolve({ ok: false, error: 'Simulated workflow refusal' }) : send(message, callback);
      });
      await page.locator('textarea').fill('New conversation without prior preferences.');
      await page.locator('textarea').press('Enter');
      await page.getByText('⚠️ Error: Simulated workflow refusal', { exact: true }).waitFor();
      assert.equal(await page.locator('textarea').isEnabled(), true);
      passed.push('An explicit negative workflow acknowledgement displays the failure and releases the input');

      // Persist a recovery before recreating the whole side-panel document. The
      // GET_CONNECTIONS replay is emitted immediately by the Chrome double, so
      // this verifies the listener is ready before it requests the replay and
      // that the next-paint receipt belongs to the new panel client.
      await page.evaluate(() => localStorage.setItem('readiness-fixture-recovery', JSON.stringify({
        recoveryId: 'recovery-after-remount', workflowId: 'recovery-workflow',
        provider: 'gemini', failedRequestId: 'recovery-request',
        reason: 'i18n:{"key":"error.timeout","params":{"provider":"Gemini","seconds":600}}',
        failureKind: 'response_timeout',
      })));
      await page.reload();
      const recoveryAlert = page.getByRole('alert');
      await recoveryAlert.waitFor();
      const recoveryTitle = recoveryAlert.getByText(t('recovery.title', { provider: 'Gemini' }, language), { exact: true });
      assert.equal(await recoveryTitle.count(), 1);
      assert.equal(await recoveryAlert.getByText(label('recovery.failure.response_timeout'), { exact: true }).count(), 1);
      await page.waitForFunction(() => window.readinessFixture.presentedRecoveries.length === 1);
      const receipt = await page.evaluate(() => window.readinessFixture.presentedRecoveries[0]);
      assert.equal(receipt.clientId, await page.evaluate(() => window.readinessFixture.scope.clientId));
      assert.equal(receipt.sessionId, await page.evaluate(() => window.readinessFixture.scope.sessionId));
      await recoveryAlert.getByRole('button', { name: label('recovery.skip'), exact: true }).click();
      await page.waitForFunction(() => window.readinessFixture.recoveryDecisions.length === 1);
      assert.deepEqual(await page.evaluate(() => window.readinessFixture.recoveryDecisions[0]), {
        recoveryId: receipt.recoveryId, workflowId: receipt.workflowId,
        sessionId: receipt.sessionId, clientId: receipt.clientId,
        provider: receipt.provider, failedRequestId: receipt.failedRequestId,
        action: 'skip',
      });
      passed.push('A pending recovery replay after a side-panel remount renders Retry/Skip/Cancel before acknowledgement, records a scoped next-paint receipt, and accepts Skip');
    } catch (error) {
      report.status = 'FAIL';
      report.errors.push(`${language}: ${error.message}`);
      throw error;
    } finally { await context.close(); saveReport(); }
  }
  report.status = report.errors.length ? 'FAIL' : 'PASS';
  saveReport();
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
}

(async () => {
  const connected = Boolean(process.env.READINESS_CDP_URL);
  const browser = connected
    ? await chromium.connectOverCDP(process.env.READINESS_CDP_URL)
    : await chromium.launch({ headless: true, executablePath: process.env.READINESS_BROWSER });
  try { await run(browser); }
  finally {
    // Only our contexts are closed above. Never close a shared CDP browser.
    if (!connected) await browser.close();
  }
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
