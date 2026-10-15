import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AIProvider, AutonomousRecoverySettings, Locale, ThemeMode } from '../../shared/types';
import { ALL_PROVIDERS } from '../../shared/providerSelection';
import { AI_PROVIDERS } from '../../shared/constants';
import { getHackMDToken, setHackMDToken, clearHackMDToken } from '../../shared/hackmd';
import { LOCALE_LABELS, SUPPORTED_LOCALES, t } from '../../shared/i18n';
import { THEME_MODES } from '../../shared/theme';
import { includesMetaOrigin, META_ORIGINS } from '../../shared/metaOrigins';
import { planMetaHostPermission } from '../metaHostPermission';

const DEFAULT_AUTONOMOUS_RECOVERY: AutonomousRecoverySettings = { enabled: false, policy: 'safe' };

interface Props {
  isOpen: boolean;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  autonomousRecovery?: AutonomousRecoverySettings;
  onAutonomousRecoveryChange?: (settings: AutonomousRecoverySettings) => void;
  standbyProvider: AIProvider;
  onStandbyChange: (provider: AIProvider) => Promise<void>;
  providerSelectionDisabled: boolean;
  onClose: () => void;
}

type TokenState = 'loading' | 'load-error' | 'ready' | 'saving' | 'clearing' | 'saved';
interface SettingsSession {
  active: boolean;
  state: TokenState;
  closeTimer?: number;
}

export default function SettingsModal({ isOpen, locale, onLocaleChange, theme, onThemeChange, autonomousRecovery, onAutonomousRecoveryChange, standbyProvider, onStandbyChange, providerSelectionDisabled, onClose }: Props) {
  const recovery = autonomousRecovery ?? DEFAULT_AUTONOMOUS_RECOVERY;
  const updateRecovery = onAutonomousRecoveryChange ?? (() => {});
  const [token, setToken] = useState('');
  const [tokenState, setTokenState] = useState<TokenState>('loading');
  const [tokenErrorKey, setTokenErrorKey] = useState('');
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [providerError, setProviderError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const sessionRef = useRef<SettingsSession | null>(null);
  const pendingWriteRef = useRef<Promise<void> | null>(null);
  const metaAccessRef = useRef(false);

  const updateTokenState = (session: SettingsSession, state: TokenState) => {
    if (!session.active) return;
    session.state = state;
    setTokenState(state);
  };

  const loadToken = async (session: SettingsSession) => {
    updateTokenState(session, 'loading');
    setTokenErrorKey('');
    setToken('');
    try {
      // An already requested write still completes after dismissal. Read it before allowing another edit.
      await pendingWriteRef.current?.catch(() => {});
      if (!session.active) return;
      const existing = await getHackMDToken();
      if (!session.active) return;
      setToken(existing ?? '');
      updateTokenState(session, 'ready');
    } catch {
      if (!session.active) return;
      setTokenErrorKey('settings.token_load_failed');
      updateTokenState(session, 'load-error');
    }
  };

  const dismiss = () => {
    const session = sessionRef.current;
    if (session) {
      session.active = false;
      window.clearTimeout(session.closeTimer);
    }
    onClose();
  };

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);

  useEffect(() => {
    const update = (granted: boolean) => (changed: chrome.permissions.Permissions) => {
      if (includesMetaOrigin(changed.origins)) metaAccessRef.current = granted;
    };
    const onAdded = update(true);
    const onRemoved = update(false);
    chrome.permissions.onAdded.addListener(onAdded);
    chrome.permissions.onRemoved.addListener(onRemoved);
    return () => {
      chrome.permissions.onAdded.removeListener(onAdded);
      chrome.permissions.onRemoved.removeListener(onRemoved);
    };
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const session: SettingsSession = { active: true, state: 'loading' };
    sessionRef.current = session;
    setProviderError('');
    void loadToken(session);
    void chrome.permissions.contains({ origins: [...META_ORIGINS] }).then((granted) => {
      if (session.active) metaAccessRef.current = granted;
    }, (error: unknown) => {
      console.error('Could not check Meta AI host access', error);
    });
    return () => {
      session.active = false;
      window.clearTimeout(session.closeTimer);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    } else if (event.key === 'Tab') {
      const dialog = event.currentTarget;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]'))
        .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const writeToken = async (action: 'save' | 'clear') => {
    const session = sessionRef.current;
    if (!session?.active || session.state !== 'ready') return;
    updateTokenState(session, action === 'save' ? 'saving' : 'clearing');
    setTokenErrorKey('');
    // Keep Escape and Tab available when the action button becomes disabled.
    cancelButtonRef.current?.focus();
    const trimmed = token.trim();
    const operation = (async () => {
      if (action === 'save' && trimmed) await setHackMDToken(trimmed);
      else await clearHackMDToken();
      if (action === 'save') await chrome.storage.local.set({ language: locale });
    })();
    pendingWriteRef.current = operation;
    try {
      await operation;
      if (!session.active) return;
      if (action === 'save') {
        updateTokenState(session, 'saved');
        session.closeTimer = window.setTimeout(() => {
          if (session.active) dismiss();
        }, 500);
      } else {
        setToken('');
        updateTokenState(session, 'ready');
      }
    } catch {
      if (!session.active) return;
      setTokenErrorKey(action === 'save' ? 'settings.save_failed' : 'settings.clear_failed');
      updateTokenState(session, 'ready');
    } finally {
      if (pendingWriteRef.current === operation) pendingWriteRef.current = null;
    }
  };
  const tokenControlsDisabled = tokenState !== 'ready';

  const handleStandbyChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const session = sessionRef.current;
    const next = event.target.value as AIProvider;
    const plan = planMetaHostPermission({
      nextStandby: next,
      hasPermission: metaAccessRef.current,
    });
    // chrome.permissions.request() only counts as a user gesture in this turn, before any await.
    let requested: Promise<boolean> | undefined;
    if (plan.action === 'request') {
      try {
        requested = chrome.permissions.request({ origins: [...META_ORIGINS] });
      } catch (error: unknown) {
        console.error('Could not request Meta AI host access', error);
        requested = Promise.resolve(false);
      }
    }
    setSwitchingProvider(true);
    setProviderError('');
    void (async () => {
      if (requested) {
        let granted = false;
        try {
          granted = await requested;
        } catch (error: unknown) {
          // A rejected request (for example, no user gesture) is "not granted", same as resolving false.
          console.error('Could not request Meta AI host access', error);
        }
        metaAccessRef.current = granted;
        const after = planMetaHostPermission({
          nextStandby: next,
          hasPermission: granted,
          requested: true,
        });
        if (after.action === 'keep') {
          if (session?.active) setProviderError(t(after.messageKey));
          return;
        }
      }
      await onStandbyChange(next);
    })().catch((error: unknown) => {
      if (session?.active) setProviderError(error instanceof Error ? error.message : String(error));
    }).finally(() => setSwitchingProvider(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs" onClick={dismiss}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} onKeyDown={handleKeyDown} className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 id="settings-title" className="text-base font-semibold text-slate-900">{t('settings.title')}</h2>
          <button type="button" onClick={dismiss} className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">{t('app.close')}</button>
        </div>

        <label className="mt-4 block text-xs font-semibold text-slate-700" htmlFor="language-select">{t('settings.language')}</label>
        <select id="language-select" value={locale} disabled={tokenState === 'loading' || tokenState === 'saving' || tokenState === 'saved'} onChange={(event) => onLocaleChange(event.target.value as Locale)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-hidden focus:border-sky-400 disabled:opacity-50">
          {SUPPORTED_LOCALES.map((candidate) => <option key={candidate} value={candidate}>{LOCALE_LABELS[candidate]}</option>)}
        </select>

        <label className="mt-4 block text-xs font-semibold text-slate-700" htmlFor="theme-select">{t('settings.theme')}</label>
        <select id="theme-select" value={theme} onChange={(event) => onThemeChange(event.target.value as ThemeMode)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-hidden focus:border-sky-400">
          {THEME_MODES.map((mode) => <option key={mode} value={mode}>{t(`settings.theme.${mode}`)}</option>)}
        </select>

        <section className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3" aria-labelledby="recovery-settings-title">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 id="recovery-settings-title" className="text-xs font-semibold text-slate-700">{t('settings.recovery')}</h3>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{t('settings.recovery.help')}</p>
            </div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700" htmlFor="recovery-enabled">
              <input id="recovery-enabled" type="checkbox" checked={recovery.enabled}
                onChange={(event) => updateRecovery({ ...recovery, enabled: event.target.checked })} />
              {t('settings.recovery.enabled')}
            </label>
          </div>
          <label className="mt-2 block text-xs font-medium text-slate-700" htmlFor="recovery-policy">{t('settings.recovery.policy')}</label>
          <select id="recovery-policy" value={recovery.policy}
            disabled={!recovery.enabled}
            onChange={(event) => updateRecovery({ ...recovery, policy: event.target.value as AutonomousRecoverySettings['policy'] })}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-hidden focus:border-sky-400 disabled:opacity-50">
            <option value="safe">{t('settings.recovery.safe')}</option>
            <option value="strict">{t('settings.recovery.strict')}</option>
            <option value="best-effort">{t('settings.recovery.best_effort')}</option>
          </select>
        </section>

        <label className="mt-4 block text-xs font-semibold text-slate-700" htmlFor="standby-provider">{t('settings.standby')}</label>
        <select
          id="standby-provider"
          value={standbyProvider}
          disabled={providerSelectionDisabled || switchingProvider}
          aria-busy={switchingProvider || undefined}
          aria-invalid={Boolean(providerError) || undefined}
          aria-describedby={providerError ? 'standby-help standby-error' : 'standby-help'}
          onChange={handleStandbyChange}
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-hidden focus:border-sky-400 disabled:opacity-50"
        >
          {ALL_PROVIDERS.map((provider) => <option key={provider} value={provider}>{AI_PROVIDERS[provider].name}</option>)}
        </select>
        <p id="standby-help" className="mt-1.5 text-xs leading-relaxed text-slate-500">{t('settings.standby.help')}</p>
        {providerError && <p id="standby-error" role="alert" className="mt-1 text-xs text-red-700">{providerError}</p>}

        <label className="mt-4 block text-xs font-semibold text-slate-700" htmlFor="hackmd-token">{t('settings.hackmd.label')}</label>
        <input
          id="hackmd-token"
          type="password"
          value={token}
          disabled={tokenControlsDisabled}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(tokenErrorKey) || undefined}
          aria-describedby={tokenState === 'loading' ? 'settings-token-status' : tokenErrorKey ? 'settings-token-error' : undefined}
          onChange={(event) => setToken(event.target.value)}
          placeholder="hmd_xxxxxxxxxxxxxxxx"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-hidden focus:border-sky-400 disabled:opacity-50"
        />
        {tokenState === 'loading' && <p id="settings-token-status" role="status" className="mt-1 text-xs text-slate-500">{t('settings.token_loading')}</p>}
        {tokenErrorKey && <p id="settings-token-error" role="alert" className="mt-1 text-xs text-red-700">{t(tokenErrorKey)}</p>}
        {tokenState === 'load-error' && <button type="button" onClick={() => {
          const session = sessionRef.current;
          if (!session?.active || session.state !== 'load-error') return;
          dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
          void loadToken(session);
        }} className="mt-1 rounded-lg border border-sky-300 px-2 py-1 text-xs text-sky-700">{t('recovery.retry')}</button>}
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          {t('settings.hackmd.help')}{' '}
          <a href="https://hackmd.io/settings#api" target="_blank" rel="noopener noreferrer" className="text-sky-700 underline">hackmd.io/settings → API</a>
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-amber-700">{t('settings.hackmd.local')}</p>

        <section className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{t('settings.about')}</h3>
          <a href="https://ai-sister.com" target="_blank" rel="noopener noreferrer" className="mt-2 block text-sm font-semibold text-sky-700 hover:underline">{t('settings.sponsored')}</a>
          <a href="mailto:TED@TED-H.com" className="mt-1 block text-xs text-slate-600 hover:text-sky-700">{t('settings.author')}</a>
          <a href="https://ted-h.com" target="_blank" rel="noopener noreferrer" className="mt-1 block text-xs text-sky-700 hover:underline">https://{t('settings.website')}</a>
        </section>

        <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-3">
          <button type="button" onClick={() => void writeToken('clear')} disabled={tokenControlsDisabled} aria-busy={tokenState === 'clearing'} className="text-xs text-slate-500 hover:text-red-600 disabled:opacity-50">{t('settings.clear')}</button>
          <div className="flex gap-2">
            <button ref={cancelButtonRef} type="button" onClick={dismiss} className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">{t('settings.cancel')}</button>
            <button type="button" onClick={() => void writeToken('save')} disabled={tokenControlsDisabled} aria-busy={tokenState === 'saving'} aria-label={tokenState === 'saved' ? t('settings.saved') : undefined} className="min-w-[64px] rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50">{tokenState === 'saved' ? '✓' : t('settings.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
