import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { AI_PROVIDERS, CHAT_MODES, DEFAULT_DEBATE_ROLES } from '../src/shared/constants.ts';
import { LOCALE_LABELS, SUPPORTED_LOCALES, setLocale, t } from '../src/shared/i18n.ts';
import type { AIConnection, AIProvider } from '../src/shared/types.ts';
import * as metaOrigins from '../src/shared/metaOrigins.ts';
import * as metaHostPermission from '../src/sidepanel/metaHostPermission.ts';

const ALL_PROVIDERS: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok', 'meta'];
const THEME_MODES = ['system', 'light', 'dark'] as const;
const activeProviders: AIProvider[] = ['chatgpt', 'claude', 'gemini', 'grok'];

test('Markdown display preserves intraword underscores in provider replies', () => {
  const MarkdownText = loadComponent('../src/sidepanel/components/MarkdownText.tsx').default;
  const literal = renderToStaticMarkup(React.createElement(MarkdownText, { text: 'MULTIAI_OK_1410 and foo__bar__baz' }));
  assert.match(literal, /MULTIAI_OK_1410 and foo__bar__baz/);
  const emphasis = renderToStaticMarkup(React.createElement(MarkdownText, { text: '_emphasis_ and __strong__' }));
  assert.match(emphasis, /<em[^>]*>emphasis<\/em>/);
  assert.match(emphasis, /<strong[^>]*>strong<\/strong>/);
});

function loadComponent(
  relativePath: string,
  reactImpl: typeof React = React,
  sandbox?: Record<string, unknown>,
): { default: React.ComponentType<any> } {
  const module = { exports: {} as { default: React.ComponentType<any> } };
  const code = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const runner = sandbox
    ? vm.runInNewContext(`(function(require, module, exports) {${code}\n})`, sandbox)
    : vm.runInNewContext(`(function(require, module, exports) {${code}\n})`);
  runner(
    (id: string) => {
      if (id === 'react') return reactImpl;
      if (id === '../../shared/i18n') return { t, LOCALE_LABELS, SUPPORTED_LOCALES };
      if (id === '../../shared/constants') return { AI_PROVIDERS, CHAT_MODES };
      if (id === '../../shared/providerSelection') return { ALL_PROVIDERS };
      if (id === '../../shared/theme') return { THEME_MODES };
      if (id === '../../shared/hackmd') {
        return { getHackMDToken: async () => null, setHackMDToken: async () => {}, clearHackMDToken: async () => {} };
      }
      if (id === '../../shared/metaOrigins') return metaOrigins;
      if (id === '../metaHostPermission') return metaHostPermission;
      throw new Error(`Unexpected dependency: ${id}`);
    },
    module,
    module.exports,
  );
  return module.exports;
}

type TextareaHandlers = {
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: {
    key: string;
    shiftKey: boolean;
    preventDefault: () => void;
    nativeEvent: { isComposing: boolean; keyCode: number };
  }) => void;
};

function mountInputBar(overrides: Record<string, unknown> = {}) {
  const captured: { textarea?: TextareaHandlers; send?: { onClick?: () => void } } = {};
  const reactImpl = new Proxy(React, {
    get(target, prop, receiver) {
      if (prop === 'createElement') {
        return (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
          if (type === 'textarea' && props) captured.textarea = props as TextareaHandlers;
          const label = props?.children ?? children[0];
          if (type === 'button' && label === t('input.send')) captured.send = props as { onClick?: () => void };
          return React.createElement(type as React.ElementType, props, ...children);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const InputBar = loadComponent('../src/sidepanel/components/InputBar.tsx', reactImpl as typeof React).default;
  const sent: string[] = [];
  setLocale('en');
  const markup = renderToStaticMarkup(React.createElement(InputBar, {
    onSend: (text: string) => sent.push(text),
    onCancel: () => {},
    disabled: false,
    isProcessing: false,
    ...overrides,
  }));
  return { markup, sent, textarea: captured.textarea!, send: captured.send! };
}

function enterEvent(overrides: { isComposing?: boolean; keyCode?: number; shiftKey?: boolean } = {}) {
  let prevented = false;
  return {
    event: {
      key: 'Enter',
      shiftKey: Boolean(overrides.shiftKey),
      preventDefault: () => { prevented = true; },
      nativeEvent: { isComposing: Boolean(overrides.isComposing), keyCode: overrides.keyCode ?? 13 },
    },
    wasPrevented: () => prevented,
  };
}

test('InputBar Enter and Send fire the real handlers once; IME confirmation does not send', () => {
  const { markup, sent, textarea, send } = mountInputBar();
  assert.match(markup, /aria-label="Message to selected AIs"/);
  assert.equal(typeof textarea.onChange, 'function');
  assert.equal(typeof textarea.onKeyDown, 'function');
  assert.equal(typeof send.onClick, 'function');

  textarea.onChange!({ target: { value: '入力法確認 日本語 한국어' } });
  const composing = enterEvent({ isComposing: true, keyCode: 13 });
  textarea.onKeyDown!(composing.event);
  assert.equal(composing.wasPrevented(), false);
  const keyCode229 = enterEvent({ isComposing: false, keyCode: 229 });
  textarea.onKeyDown!(keyCode229.event);
  assert.equal(keyCode229.wasPrevented(), false);
  const newline = enterEvent({ shiftKey: true });
  textarea.onKeyDown!(newline.event);
  assert.equal(newline.wasPrevented(), false);
  assert.equal(sent.length, 0);

  const first = enterEvent();
  textarea.onKeyDown!(first.event);
  assert.equal(first.wasPrevented(), true);
  const second = enterEvent();
  textarea.onKeyDown!(second.event);
  send.onClick!();
  assert.deepEqual(sent, ['入力法確認 日本語 한국어']);
});

test('InputBar Send click consumes the draft before a second click can send', () => {
  const { sent, textarea, send } = mountInputBar();
  textarea.onChange!({ target: { value: '  Hello AIs  ' } });
  send.onClick!();
  send.onClick!();
  assert.deepEqual(sent, ['Hello AIs']);
});

test('disabled InputBar handlers do not send and keep the stable accessible name', () => {
  const { markup, sent, textarea } = mountInputBar({ disabled: true, isProcessing: true });
  assert.match(markup, /aria-label="Message to selected AIs"/);
  assert.match(markup, /placeholder="Workflow is running…"/);
  textarea.onChange!({ target: { value: 'should not send' } });
  const enter = enterEvent();
  textarea.onKeyDown!(enter.event);
  assert.equal(sent.length, 0);
});

test('role buttons expose type, pressed state and a labelled group per role', () => {
  setLocale('en');
  const RoleConfig = loadComponent('../src/sidepanel/components/RoleConfig.tsx').default;
  const markup = renderToStaticMarkup(React.createElement(RoleConfig, {
    providers: activeProviders, mode: 'debate', roles: DEFAULT_DEBATE_ROLES, onRolesChange: () => {},
  }));
  assert.equal(markup.match(/role="group"/g)?.length, 4);
  assert.match(markup, /aria-labelledby="role-label-pro"/);
  assert.match(markup, /id="role-label-pro"[^>]*>Pro</);
  assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 4);
  assert.equal((markup.match(/aria-pressed="false"/g) ?? []).length, 12);
  assert.equal((markup.match(/type="button"/g) ?? []).length, 16);
  assert.doesNotMatch(markup, /<button(?![^>]*type="button")/);
});

test('role buttons are disabled when disabled is true and enabled otherwise', () => {
  setLocale('en');
  const changes: unknown[] = [];
  const scrolls: number[] = [];
  const captured: Array<{
    disabled?: boolean;
    onClick?: () => void;
    onFocus?: (event: { currentTarget: { scrollIntoView: () => void } }) => void;
  }> = [];
  const reactImpl = new Proxy(React, {
    get(target, prop, receiver) {
      if (prop === 'createElement') {
        return (type: unknown, props: typeof captured[number] | null, ...children: unknown[]) => {
          if (type === 'button' && props) captured.push(props);
          return target.createElement(type as React.ElementType, props, ...children);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const RoleConfig = loadComponent('../src/sidepanel/components/RoleConfig.tsx', reactImpl as typeof React).default;
  const props = {
    providers: activeProviders, mode: 'debate' as const, roles: DEFAULT_DEBATE_ROLES,
    onRolesChange: (next: unknown) => changes.push(next),
  };
  const render = (extra: { disabled?: boolean } = {}) => {
    captured.length = 0;
    return renderToStaticMarkup(React.createElement(RoleConfig, { ...props, ...extra }));
  };
  const focus = () => ({ currentTarget: { scrollIntoView() { scrolls.push(scrolls.length + 1); } } });
  for (const markup of [render(), render({ disabled: false })]) {
    const tags = markup.match(/<button\b[^>]*>/g) ?? [];
    assert.equal(tags.length, 16);
    assert.equal(tags.some((tag) => tag.includes(' disabled=""')), false);
    assert.match(markup, /id="role-label-summary"[^>]*hyphens-auto/);
    assert.match(markup, /id="role-label-summary"[^>]*break-words/);
  }
  assert.equal(captured.length, 16);
  assert.equal(captured.every((button) => button.disabled === false), true);
  captured[0].onClick!();
  captured[0].onFocus!(focus());
  assert.equal(changes.length, 1);
  assert.equal(scrolls.length, 1);

  const disabledMarkup = render({ disabled: true });
  const disabledTags = disabledMarkup.match(/<button\b[^>]*>/g) ?? [];
  assert.equal(disabledTags.length, 16);
  assert.equal(disabledTags.every((tag) => tag.includes(' disabled=""')), true);
  assert.match(disabledTags[0], /disabled:cursor-not-allowed/);
  assert.match(disabledTags[0], /disabled:opacity-50/);
  assert.equal(captured.every((button) => button.disabled === true), true);
  for (const button of captured) {
    button.onClick!();
    button.onFocus!(focus());
  }
  assert.equal(changes.length, 1);
  assert.equal(scrolls.length, 1);
});

test('connection buttons name status in five locales and mark checking as busy', () => {
  const ConnectionBar = loadComponent('../src/sidepanel/components/ConnectionBar.tsx').default;
  const connections = {
    chatgpt: { provider: 'chatgpt', status: 'connected' },
    claude: { provider: 'claude', status: 'checking' },
    gemini: { provider: 'gemini', status: 'login-required' },
    grok: { provider: 'grok', status: 'disconnected' },
  } as Record<AIProvider, AIConnection>;
  for (const locale of SUPPORTED_LOCALES) {
    setLocale(locale);
    const markup = renderToStaticMarkup(React.createElement(ConnectionBar, {
      providers: activeProviders, connections, onOpenLogin: () => {},
    }));
    assert.match(markup, new RegExp(`ChatGPT[\\s\\S]*${t('connection.connected', undefined, locale)}`));
    assert.match(markup, /aria-busy="true"/);
    assert.match(markup, new RegExp(`Claude[\\s\\S]*${t('connection.checking', undefined, locale)}`));
    assert.match(markup, new RegExp(`Gemini[\\s\\S]*${t('connection.login', undefined, locale)}`));
    assert.match(markup, new RegExp(`Grok[\\s\\S]*${t('connection.open', undefined, locale)}`));
    if (locale !== 'en') {
      assert.notEqual(t('connection.checking', undefined, locale), t('connection.checking', undefined, 'en'));
    }
  }
});

test('open Settings dialog describes loading token and wires token error ids', () => {
  setLocale('en');
  const SettingsModal = loadComponent('../src/sidepanel/components/SettingsModal.tsx').default;
  const markup = renderToStaticMarkup(React.createElement(SettingsModal, {
    isOpen: true, locale: 'en', onLocaleChange: () => {}, theme: 'system', onThemeChange: () => {},
    standbyProvider: 'meta', onStandbyChange: async () => {}, providerSelectionDisabled: false, onClose: () => {},
  }));
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /aria-labelledby="settings-title"/);
  assert.match(markup, /id="hackmd-token"[^>]*disabled=""/);
  assert.match(markup, /id="hackmd-token"[^>]*aria-describedby="settings-token-status"/);
  assert.match(markup, /id="hackmd-token"[^>]*autoComplete="off"/);
  assert.match(markup, /id="settings-token-status" role="status"/);
  assert.match(markup, /id="standby-provider"[^>]*aria-describedby="standby-help"/);
  assert.match(markup, /id="standby-help"/);
  assert.match(markup, /id="recovery-enabled"[^>]*type="checkbox"/);
  assert.match(markup, /id="recovery-policy"[^>]*disabled=""/);
  const source = readFileSync(new URL('../src/sidepanel/components/SettingsModal.tsx', import.meta.url), 'utf8');
  assert.match(source, /shared\/metaOrigins/);
  assert.doesNotMatch(source, /background\/metaHostAccess/);
  assert.match(source, /id="settings-token-error"/);
  assert.match(source, /aria-invalid=\{Boolean\(tokenErrorKey\) \|\| undefined\}/);
  assert.match(source, /tokenErrorKey \? 'settings-token-error'/);
  assert.equal(renderToStaticMarkup(React.createElement(SettingsModal, {
    isOpen: false, locale: 'en', onLocaleChange: () => {}, theme: 'system', onThemeChange: () => {},
    standbyProvider: 'meta', onStandbyChange: async () => {}, providerSelectionDisabled: false, onClose: () => {},
  })), '');
});

test('a rejected Meta permission request stays on standby and shows the localized denial', async () => {
  setLocale('ja');
  const gestureError = new Error('This function must be called during a user gesture');
  const logged: unknown[][] = [];
  const stateUpdates: unknown[] = [];
  const layoutEffects: Array<() => void> = [];
  let requestedOrigins: readonly string[] | undefined;
  let applied = false;
  const reactImpl = new Proxy(React, {
    get(target, prop, receiver) {
      if (prop === 'useState') {
        return (initial: unknown) => {
          const [value, setValue] = target.useState(initial);
          return [value, (next: unknown) => {
            stateUpdates.push(next);
            return setValue(next);
          }];
        };
      }
      if (prop === 'useLayoutEffect') {
        return (effect: () => void, deps?: unknown) => {
          layoutEffects.push(effect);
          return target.useLayoutEffect(effect, deps as undefined);
        };
      }
      if (prop === 'createElement') {
        return (type: unknown, props: { id?: string; onChange?: (event: { target: { value: string } }) => void } | null, ...children: unknown[]) => {
          if (type === 'select' && props?.id === 'standby-provider') captured.onChange = props.onChange;
          return target.createElement(type as React.ElementType, props, ...children);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const captured: { onChange?: (event: { target: { value: string } }) => void } = {};
  const SettingsModal = loadComponent('../src/sidepanel/components/SettingsModal.tsx', reactImpl as typeof React, {
    console: {
      error: (...args: unknown[]) => { logged.push(args); },
      info() {},
      log() {},
      warn() {},
    },
    window: { setTimeout, clearTimeout },
    chrome: {
      permissions: {
        contains: () => new Promise(() => {}),
        request: (permissions: { origins?: readonly string[] }) => {
          requestedOrigins = permissions.origins;
          return Promise.reject(gestureError);
        },
        onAdded: { addListener() {}, removeListener() {} },
        onRemoved: { addListener() {}, removeListener() {} },
      },
    },
  }).default;
  try {
    renderToStaticMarkup(React.createElement(SettingsModal, {
      isOpen: true, locale: 'ja', onLocaleChange: () => {}, theme: 'system', onThemeChange: () => {},
      standbyProvider: 'meta', onStandbyChange: async () => { applied = true; }, providerSelectionDisabled: false, onClose: () => {},
    }));
    assert.equal(layoutEffects.length, 1);
    layoutEffects[0]();
    assert.equal(typeof captured.onChange, 'function');
    captured.onChange!({ target: { value: 'grok' } });
    await new Promise((resolve) => setImmediate(resolve));
    const denied = t('settings.meta_permission_denied', undefined, 'ja');
    assert.equal(stateUpdates.includes(denied), true);
    assert.equal(stateUpdates.includes(gestureError.message), false);
    assert.equal(stateUpdates.includes('Meta AI host access was not resolved'), false);
    assert.notEqual(denied, t('settings.meta_permission_denied', undefined, 'en'));
    assert.equal(JSON.stringify(requestedOrigins), JSON.stringify([...metaOrigins.META_ORIGINS]));
    assert.equal(applied, false);
    assert.equal(logged.some((entry) => entry.includes(gestureError)), true);
  } finally {
    setLocale('en');
  }
});

test('mode selector keeps a named group with exactly one pressed mode', () => {
  setLocale('en');
  const ModeSelector = loadComponent('../src/sidepanel/components/ModeSelector.tsx').default;
  const markup = renderToStaticMarkup(React.createElement(ModeSelector, { mode: 'coding', onModeChange: () => {} }));
  assert.match(markup, /role="group" aria-label="Chat mode"/);
  assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((markup.match(/aria-pressed="false"/g) ?? []).length, 4);
  assert.match(markup, />Coding<\/span>/);
});

test('Coding and Roundtable remain visible next to Send independently of the scrolled mode selector', () => {
  for (const mode of ['coding', 'roundtable']) {
    const { markup } = mountInputBar({ mode });
    assert.ok(markup.includes(`aria-label="Chat mode: ${t(`mode.${mode}`)}"`));
    assert.ok(markup.includes(`>${t(`mode.${mode}`)}</span>`));
  }
  const source = readFileSync(new URL('../src/sidepanel/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /ModeSelector[^\n]+disabled=\{!hydrated \|\| isProcessing\}/);
  assert.match(source, /<InputBar mode=\{mode\}/);
});

test('workflow controls retain every trace entry in one reachable scroll container and keep New chat reachable', () => {
  const source = readFileSync(new URL('../src/sidepanel/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /Object\.entries\(roles as unknown as Record<string, AIProvider>\)/);
  assert.match(source, /break-words text-\[11px\] leading-relaxed text-slate-600/);
  assert.match(source, /const \[traceOpen, setTraceOpen\] = useState\(false\)/);
  assert.match(source, /open=\{isProcessing \|\| traceOpen\}/);
  assert.match(source, /onToggle=\{\(event\) => setTraceOpen\(event\.currentTarget\.open\)\}/);
  // Actual Send/Stop visibility and trace reachability are checked in Chromium.
  assert.match(source, /max-h-\[46vh\][^"\n]*overflow-y-auto overscroll-contain/);
  assert.doesNotMatch(source, /trace\.slice\(/);
  assert.doesNotMatch(source, /max-h-56[^\n]*overflow-y-auto[^\n]*\{trace\.map/);
  assert.match(source, /onClick=\{startNewConversation\}[^>]*>\{t\('app\.new'\)\}/);
});

test('ja, de and ko no longer fall back to English for product strings zh already translated', () => {
  const params = { provider: 'ChatGPT', providers: 'ChatGPT · Claude', ready: 'Meta AI', detail: 'closed', seconds: 30, status: '401' };
  const keys = [
    'session.delete', 'settings.hackmd.label', 'settings.meta_permission_denied', 'connection.connect_all',
    'error.input_not_found', 'error.input_injection_failed', 'error.input_disappeared',
    'error.send_failed', 'error.send_rejected', 'error.no_response_text', 'error.response_in_progress',
    'error.empty_message', 'error.not_ready', 'error.navigated_away', 'error.reloaded', 'error.tab_closed',
    'error.timeout', 'error.no_target', 'error.worker_stopped', 'error.hackmd_failed', 'error.hackmd_no_link',
  ];
  for (const locale of ['ja', 'de', 'ko'] as const) {
    for (const key of keys) {
      const text = t(key, params, locale);
      assert.notEqual(text, key, `${locale} ${key}`);
      assert.doesNotMatch(text, /\{\w+\}/);
      if (key !== 'error.hackmd_failed') {
        assert.notEqual(text, t(key, params, 'en'), `${locale} ${key} must not fall back to English`);
      }
    }
  }
  for (const key of ['app.title', 'settings.sponsored', 'settings.author', 'settings.website']) {
    assert.equal(t(key, undefined, 'ja'), t(key, undefined, 'en'));
  }
});

test('SettingsModal manages local session state and avoids late updates', async () => {
  setLocale('en');
  const logged: unknown[][] = [];
  const stateUpdates: unknown[] = [];
  let tokenSet: string | null = null;
  const reactImpl = new Proxy(React, {
    get(target, prop, receiver) {
      if (prop === 'useState') {
        return (initial: unknown) => {
          const [value, setValue] = target.useState(initial);
          return [value, (next: unknown) => {
            stateUpdates.push(next);
            return setValue(next);
          }];
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });

  // HackMD mock that resolves *after* the modal is closed
  let resolveToken: (token: string | null) => void;
  const tokenPromise = new Promise<string | null>((resolve) => { resolveToken = resolve; });

  const SettingsModal = loadComponent('../src/sidepanel/components/SettingsModal.tsx', reactImpl as typeof React, {
    console: { error: (...args: unknown[]) => { logged.push(args); } },
    window: { setTimeout, clearTimeout },
    chrome: {
      permissions: {
        contains: () => new Promise(() => {}),
        onAdded: { addListener() {}, removeListener() {} },
        onRemoved: { addListener() {}, removeListener() {} },
      }
    },
    '../../shared/hackmd': {
      getHackMDToken: () => tokenPromise,
      setHackMDToken: async () => {},
      clearHackMDToken: async () => {},
    }
  }).default;

  // Mount the modal
  renderToStaticMarkup(React.createElement(SettingsModal, {
    isOpen: true, locale: 'en', onLocaleChange: () => {}, theme: 'system', onThemeChange: () => {},
    standbyProvider: 'meta', onStandbyChange: async () => {}, providerSelectionDisabled: false, onClose: () => {},
  }));

  // Unmount the modal (isOpen: false triggers unmount-like logic if we don't fully tear down the DOM)
  renderToStaticMarkup(React.createElement(SettingsModal, {
    isOpen: false, locale: 'en', onLocaleChange: () => {}, theme: 'system', onThemeChange: () => {},
    standbyProvider: 'meta', onStandbyChange: async () => {}, providerSelectionDisabled: false, onClose: () => {},
  }));

  // Resolve the token after unmount
  resolveToken!('late_token');
  await new Promise((resolve) => setImmediate(resolve));

  // The state update ('ready', 'late_token') should NOT happen because session.active is false
  assert.equal(stateUpdates.includes('late_token'), false);
  assert.equal(stateUpdates.includes('ready'), false);
});
