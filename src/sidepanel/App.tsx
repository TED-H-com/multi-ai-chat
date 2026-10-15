import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AIProvider,
  AIConnection,
  ChatMode,
  ChatMessage,
  Conversation,
  Locale,
  ModeRoles,
  StepRecoveryAction,
  StepRecoveryDecision,
  StepRecoveryRequest,
  ThemeMode,
  AutonomousRecoverySettings,
  WorkflowDiagnosticPayload,
  WorkflowStatusPayload,
} from '../shared/types';
import {
  AI_PROVIDERS,
  CHAT_MODES,
  DEFAULT_DEBATE_ROLES,
  DEFAULT_CONSULT_ROLES,
  DEFAULT_CODING_ROLES,
  DEFAULT_ROUNDTABLE_ROLES,
} from '../shared/constants';
import { getLocale, setLocale as setActiveLocale, SUPPORTED_LOCALES, t } from '../shared/i18n';
import { applyTheme, THEME_MODES, watchSystemTheme } from '../shared/theme';
import { getHackMDToken, publishToHackMD } from '../shared/hackmd';
import { buildConversationReplayContext } from '../shared/conversationContinuity';
import {
  MAX_CONVERSATIONS,
  commitActiveConversation,
  createConversationPersister,
  payloadFromInputs,
  storageReadFailed,
  toPersistPayload,
  usableConversations,
  type ConversationPersistInputs,
  type ConversationPersister,
} from '../shared/conversationPersistence';
import {
  ALL_PROVIDERS,
  DEFAULT_STANDBY_PROVIDER,
  activeProviders,
  normalizeStandbyProvider,
  readyActiveTargets,
  repairRoles,
  selectedActiveTargets,
} from '../shared/providerSelection';
import { decodeError, ERROR_MARKER } from '../shared/errors';
import { DEFAULT_AUTONOMOUS_RECOVERY, normalizeAutonomousRecoverySettings } from '../shared/autonomousRecovery';
import { getProviderReadiness } from '../shared/providerReadiness';
import { openUnreadyProviders } from './openUnreadyProviders';
import { createWorkflowCancellation, createWorkflowScope } from '../shared/workflowScope';
import {
  acceptStepRecoveryMessage,
  acceptWorkflowResponse,
  activeWorkflowAfterStatus,
  shouldClearStepRecovery,
} from './stepRecoveryMessages';
import ConnectionBar from './components/ConnectionBar';
import ModeSelector from './components/ModeSelector';
import RoleConfig from './components/RoleConfig';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import SettingsModal from './components/SettingsModal';

const PROVIDERS = ALL_PROVIDERS;
const DEFAULT_ROLES: Record<Exclude<ChatMode, 'free'>, ModeRoles> = {
  debate: DEFAULT_DEBATE_ROLES,
  consult: DEFAULT_CONSULT_ROLES,
  coding: DEFAULT_CODING_ROLES,
  roundtable: DEFAULT_ROUNDTABLE_ROLES,
};

interface TraceEntry {
  id: string;
  text: string;
  timestamp: number;
}

function emptyConnections(): Record<AIProvider, AIConnection> {
  return Object.fromEntries(PROVIDERS.map((provider) => [provider, { provider, status: 'disconnected' }])) as Record<AIProvider, AIConnection>;
}

function newConversation(): Conversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: t('session.untitled'),
    mode: 'free',
    roles: undefined,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

// 錯誤在背景與 content script 只帶鍵值，這裡是唯一翻譯成使用者語言的地方。
// 沒帶鍵值的（原生例外、HackMD 伺服器回應）原樣顯示。
function humanizeError(text: string): string {
  const info = decodeError(text);
  if (!info) return text;
  const params: Record<string, string | number> = { ...info.params };
  if (typeof params.provider === 'string' && params.provider in AI_PROVIDERS) {
    params.provider = AI_PROVIDERS[params.provider as AIProvider].name;
  }
  return `${ERROR_MARKER} ${t(info.key, params)}`;
}

function buildMarkdown(messages: ChatMessage[], mode: ChatMode): { title: string; content: string } {
  const title = `Multi-AI Chat — ${CHAT_MODES[mode].icon} ${t(`mode.${mode}`)}`;
  const lines = [`# ${title}`, `> Exported: ${new Date().toLocaleString()}`, '', '---', ''];
  for (const message of messages) {
    if (message.role === 'user') {
      lines.push('## 👤 User', '', ...message.content.split('\n').map((line) => `> ${line}`));
    } else {
      const provider = message.provider as string | undefined;
      const providerName = provider && provider in AI_PROVIDERS ? AI_PROVIDERS[provider as AIProvider].name : t('chat.system');
      const role = message.modeRole ? ` (${t(message.modeRole)})` : '';
      lines.push(`## 🤖 ${providerName}${role}`, '', message.content);
    }
    lines.push('', '---', '');
  }
  return { title, content: lines.join('\n') };
}

function formatWorkflowStatus(status: WorkflowStatusPayload): string {
  const params = { ...(status.params ?? {}) };
  if (typeof params.actionKey === 'string') params.action = t(params.actionKey);
  if (typeof params.labelKey === 'string') params.label = t(params.labelKey);
  return t(status.key, params);
}

export default function App() {
  const [connections, setConnections] = useState<Record<AIProvider, AIConnection>>(emptyConnections);
  const [mode, setMode] = useState<ChatMode>('free');
  const [roles, setRoles] = useState<ModeRoles>(DEFAULT_DEBATE_ROLES);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [standbyProvider, setStandbyProvider] = useState<AIProvider>(DEFAULT_STANDBY_PROVIDER);
  const standbyProviderRef = useRef(DEFAULT_STANDBY_PROVIDER);
  const providers = activeProviders(standbyProvider);
  const [freeTargets, setFreeTargets] = useState<AIProvider[]>(() => activeProviders(DEFAULT_STANDBY_PROVIDER));
  const [isProcessing, setIsProcessing] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatusPayload | null>(null);
  const [stepRecovery, setStepRecovery] = useState<StepRecoveryRequest | null>(null);
  const [isResolvingRecovery, setIsResolvingRecovery] = useState(false);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [traceOpen, setTraceOpen] = useState(false);
  const [showRoleConfig, setShowRoleConfig] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [pendingRoles, setPendingRoles] = useState<Record<string, string>>({});
  const [locale, setLocale] = useState<Locale>(getLocale());
  const [theme, setTheme] = useState<ThemeMode>('system');
  const [autonomousRecovery, setAutonomousRecovery] = useState<AutonomousRecoverySettings>(DEFAULT_AUTONOMOUS_RECOVERY);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('');
  const [providerUrls, setProviderUrls] = useState<Partial<Record<AIProvider, string>>>({});
  const [contextNeedsReplay, setContextNeedsReplay] = useState(false);
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(true);
  const [isOpeningUnready, setIsOpeningUnready] = useState(false);
  const [failedOpenProviders, setFailedOpenProviders] = useState<AIProvider[]>([]);
  const openingUnreadyRef = useRef(false);
  const [deleteTargetId, setDeleteTargetId] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const pendingRolesRef = useRef<Record<string, string>>({});
  const clientIdRef = useRef(crypto.randomUUID());
  const activeConversationIdRef = useRef('');
  const conversationRevisionRef = useRef(0);
  const activeWorkflowIdRef = useRef<string | undefined>(undefined);
  const ignoredWorkflowIdsRef = useRef(new Set<string>());
  const completedWorkflowIdsRef = useRef(new Set<string>());
  const ignoredRequestIdsRef = useRef(new Set<string>());
  const handledRecoveryIdsRef = useRef(new Set<string>());
  const stepRecoveryRef = useRef<StepRecoveryRequest | null>(null);
  const resolvingRecoveryRef = useRef(false);
  const persistInputsRef = useRef<ConversationPersistInputs>({
    conversations: [],
    activeConversationId: '',
    messages: [],
    mode: 'free',
    roles: DEFAULT_DEBATE_ROLES,
    providerUrls: {},
  });
  const persisterRef = useRef<ConversationPersister | null>(null);
  if (!persisterRef.current) {
    persisterRef.current = createConversationPersister({
      write: (payload) => { void chrome.storage.local.set(payload).catch(() => {}); },
    });
  }
  const persistEnabledRef = useRef(false);
  const skipHydratePersistRef = useRef(true);

  persistInputsRef.current = {
    conversations,
    activeConversationId,
    messages,
    mode,
    roles,
    providerUrls,
  };

  const applyProviderSelection = useCallback((next: AIProvider, targets: unknown) => {
    const previous = standbyProviderRef.current;
    standbyProviderRef.current = next;
    setStandbyProvider(next);
    setFreeTargets(selectedActiveTargets(targets, next));
    const nextRoles = repairRoles(persistInputsRef.current.roles, next, previous);
    setRoles(nextRoles);
    persistInputsRef.current = { ...persistInputsRef.current, roles: nextRoles };
    if (next !== previous) setContextNeedsReplay(true);
  }, []);

  useEffect(() => {
    pendingRolesRef.current = pendingRoles;
  }, [pendingRoles]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(() => applyTheme(theme));
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    const keys = ['language', 'theme', 'conversations', 'activeConversationId', 'freeTargets', 'standbyProvider', 'autonomousRecovery'];
    const load = () => {
      chrome.storage.local.get(keys, (stored) => {
        if (cancelled) return;
        if (storageReadFailed(chrome.runtime.lastError)) {
          attempt += 1;
          retryTimer = window.setTimeout(load, Math.min(2_000, 100 * 2 ** Math.min(attempt, 5)));
          return;
        }
        const savedLocale = stored.language as Locale | undefined;
        if (savedLocale && SUPPORTED_LOCALES.includes(savedLocale)) {
          setActiveLocale(savedLocale);
          setLocale(savedLocale);
        }

        const savedTheme = stored.theme as ThemeMode | undefined;
        if (savedTheme && THEME_MODES.includes(savedTheme)) setTheme(savedTheme);
        setAutonomousRecovery(normalizeAutonomousRecoverySettings(stored.autonomousRecovery));

        const standby = normalizeStandbyProvider(stored.standbyProvider);
        const savedConversations = usableConversations(stored.conversations);
        const selected = savedConversations.find((conversation) => conversation.id === stored.activeConversationId)
          ?? savedConversations[0]
          ?? newConversation();
        const initial = savedConversations.length ? savedConversations : [selected];
        const savedTargets = selectedActiveTargets(stored.freeTargets, standby);
        const nextRoles = repairRoles(
          selected.roles ?? (selected.mode === 'free' ? DEFAULT_DEBATE_ROLES : DEFAULT_ROLES[selected.mode] ?? DEFAULT_DEBATE_ROLES),
          standby,
        ) ?? DEFAULT_DEBATE_ROLES;
        const nextMessages = Array.isArray(selected.messages) ? selected.messages : [];
        const nextUrls = selected.providerUrls && typeof selected.providerUrls === 'object' && !Array.isArray(selected.providerUrls)
          ? selected.providerUrls
          : {};
        standbyProviderRef.current = standby;
        setStandbyProvider(standby);
        setFreeTargets(savedTargets.length ? savedTargets : activeProviders(standby));
        setConversations(initial);
        setActiveConversationId(selected.id);
        activeConversationIdRef.current = selected.id;
        setMode(selected.mode);
        setRoles(nextRoles);
        setMessages(nextMessages);
        setProviderUrls(nextUrls);
        setContextNeedsReplay(Boolean(nextMessages.length));
        persistInputsRef.current = {
          conversations: initial,
          activeConversationId: selected.id,
          messages: nextMessages,
          mode: selected.mode,
          roles: nextRoles,
          providerUrls: nextUrls,
        };
        persisterRef.current?.track(toPersistPayload(initial, selected.id));
        persisterRef.current?.enable();
        persistEnabledRef.current = true;
        skipHydratePersistRef.current = true;
        setHydrated(true);
      });
    };
    load();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let port: chrome.runtime.Port | undefined;
    let reconnectTimer: number | undefined;
    const connect = () => {
      if (stopped) return;
      port = chrome.runtime.connect({ name: 'multi-ai-sidepanel' });
      port.onDisconnect.addListener(() => {
        port = undefined;
        if (!stopped) reconnectTimer = window.setTimeout(connect, 1000);
      });
    };
    connect();
    const heartbeat = window.setInterval(() => {
      try {
        port?.postMessage({ type: 'heartbeat' });
      } catch {
        port = undefined;
      }
    }, 20_000);
    return () => {
      stopped = true;
      window.clearInterval(heartbeat);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      port?.disconnect();
    };
  }, []);

  useEffect(() => {
    const listener = (message: { action: string; provider?: AIProvider; requestId?: string; workflowId?: string; payload?: unknown }, sender: chrome.runtime.MessageSender = {}) => {
      // Content events reach extension pages directly too. Only the background's
      // validated relay may update the transcript or workflow controls.
      if (sender.tab || (sender.id && sender.id !== chrome.runtime.id)) return;
      switch (message.action) {
        case 'PROVIDER_SELECTION_UPDATE': {
          const selection = message.payload as { standbyProvider?: unknown; freeTargets?: unknown };
          applyProviderSelection(normalizeStandbyProvider(selection.standbyProvider), selection.freeTargets);
          break;
        }
        case 'CONNECTIONS_UPDATE':
          setConnections(message.payload as Record<AIProvider, AIConnection>);
          break;
        case 'ROLE_ASSIGNMENT': {
          const { labelKey, sessionId, clientId } = message.payload as { labelKey: string; sessionId?: string; clientId?: string };
          if (clientId !== clientIdRef.current || sessionId !== activeConversationIdRef.current || message.workflowId !== activeWorkflowIdRef.current) break;
          if (message.provider && (!message.requestId || !ignoredRequestIdsRef.current.has(message.requestId))) {
            const roleKey = message.requestId ?? message.provider;
            setPendingRoles((current) => {
              const next = { ...current, [roleKey]: labelKey };
              pendingRolesRef.current = next;
              return next;
            });
          }
          break;
        }
        case 'RESPONSE_CHUNK':
          if (!message.provider || !acceptWorkflowResponse(message.workflowId, activeWorkflowIdRef.current, ignoredWorkflowIdsRef.current)) break;
          if (message.requestId && ignoredRequestIdsRef.current.has(message.requestId)) break;
          setMessages((current) => upsertStreamingMessage(current, message.provider!, message.requestId, String(message.payload ?? ''), pendingRolesRef, setPendingRoles));
          break;
        case 'RESPONSE_DONE':
          if (!message.provider || !acceptWorkflowResponse(message.workflowId, activeWorkflowIdRef.current, ignoredWorkflowIdsRef.current)) break;
          if (message.requestId && ignoredRequestIdsRef.current.has(message.requestId)) break;
          setMessages((current) => finalizeMessage(current, message.provider!, message.requestId, humanizeError(String(message.payload ?? '')), pendingRolesRef, setPendingRoles));
          break;
        case 'STEP_RECOVERY_REQUIRED': {
          const recovery = acceptStepRecoveryMessage(message, {
            clientId: clientIdRef.current,
            sessionId: activeConversationIdRef.current,
            activeWorkflowId: activeWorkflowIdRef.current,
            currentRecoveryId: stepRecoveryRef.current?.recoveryId,
            ignoredWorkflowIds: ignoredWorkflowIdsRef.current,
            completedWorkflowIds: completedWorkflowIdsRef.current,
            handledRecoveryIds: handledRecoveryIdsRef.current,
          });
          if (!recovery) break;
          activeWorkflowIdRef.current = recovery.workflowId;
          ignoreRequest(recovery.failedRequestId, ignoredRequestIdsRef);
          discardPendingRole(recovery.failedRequestId, pendingRolesRef, setPendingRoles);
          setMessages((current) => current.filter((entry) => entry.requestId !== recovery.failedRequestId));
          stepRecoveryRef.current = recovery;
          setStepRecovery(recovery);
          resolvingRecoveryRef.current = false;
          setIsResolvingRecovery(false);
          setIsProcessing(true);
          // Confirm on the next paint, after the alert and its actions can be
          // rendered. The worker can then tell an unanswered visible choice
          // from a recovery request that never reached a side-panel document.
          window.requestAnimationFrame(() => {
            if (stepRecoveryRef.current?.recoveryId !== recovery.recoveryId) return;
            void chrome.runtime.sendMessage({ action: 'STEP_RECOVERY_PRESENTED', payload: recovery }).catch(() => {});
          });
          break;
        }
        case 'WORKFLOW_STATUS': {
          const status = message.payload as WorkflowStatusPayload;
          if (!status || status.clientId !== clientIdRef.current || status.sessionId !== activeConversationIdRef.current || !status.workflowId) break;
          if (ignoredWorkflowIdsRef.current.has(status.workflowId)) break;
          if (activeWorkflowIdRef.current && activeWorkflowIdRef.current !== status.workflowId) break;
          if (status.done) {
            completeWorkflow(status.workflowId, completedWorkflowIdsRef);
            setStepRecovery((current) => {
              if (!current || !shouldClearStepRecovery(current, status)) return current;
              ignoreRecovery(current.recoveryId, handledRecoveryIdsRef);
              stepRecoveryRef.current = null;
              return null;
            });
            resolvingRecoveryRef.current = false;
            setIsResolvingRecovery(false);
            if (status.cancelled) {
              clearPendingRoles(pendingRolesRef, setPendingRoles);
              ignoreWorkflow(status.workflowId, ignoredWorkflowIdsRef);
            }
            activeWorkflowIdRef.current = activeWorkflowAfterStatus(activeWorkflowIdRef.current, status);
            setWorkflowStatus(null);
            setIsProcessing(false);
            if (!status.cancelled) {
              const revision = conversationRevisionRef.current;
              chrome.runtime.sendMessage({ action: 'GET_PROVIDER_URLS' })
                // 背景只回這輪用過的 provider，要疊加而不是覆蓋，否則同一個對話先前記過的網址會掉
                .then((urls) => {
                  if (conversationRevisionRef.current !== revision || activeConversationIdRef.current !== status.sessionId) return;
                  setProviderUrls((current) => ({ ...current, ...(urls as Partial<Record<AIProvider, string>>) }));
                })
                .catch(() => {});
            }
            break;
          }
          activeWorkflowIdRef.current = status.workflowId;
          setIsProcessing(true);
          setWorkflowStatus(status);
          const text = formatWorkflowStatus(status);
          setTrace((current) => current[current.length - 1]?.text === text ? current : [...current, { id: crypto.randomUUID(), text, timestamp: Date.now() }]);
          break;
        }
        case 'WORKFLOW_DIAGNOSTIC': {
          const diagnostic = message.payload as WorkflowDiagnosticPayload;
          if (!diagnostic || diagnostic.clientId !== clientIdRef.current || diagnostic.sessionId !== activeConversationIdRef.current
            || diagnostic.workflowId !== activeWorkflowIdRef.current || diagnostic.provider !== message.provider) break;
          const providerName = AI_PROVIDERS[diagnostic.provider].name;
          const role = diagnostic.role ? ` · ${t(`role.${diagnostic.role}`)}` : '';
          const attempt = diagnostic.attempt ? ` · attempt ${diagnostic.attempt}` : '';
          const length = diagnostic.responseLength === undefined ? '' : ` · ${diagnostic.responseLength} chars`;
          const failure = diagnostic.failureKind ? ` · ${diagnostic.failureKind}` : '';
          const code = diagnostic.failureCode ? ` · ${diagnostic.failureCode}` : '';
          const candidates = diagnostic.responseCandidateCount === undefined
            ? ''
            : ` · candidates ${diagnostic.responseCandidateCount}${diagnostic.semanticResponseCandidateCount === undefined ? '' : `/${diagnostic.semanticResponseCandidateCount}`}`;
          const observed = diagnostic.generationObserved === undefined ? '' : ` · generation ${diagnostic.generationObserved ? 'seen' : 'not seen'}`;
          const text = `${providerName}${role} · ${diagnostic.stage}${attempt}${length}${failure}${code}${candidates}${observed}`;
          setTrace((current) => [...current, { id: crypto.randomUUID(), text, timestamp: Date.now() }]);
          break;
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [applyProviderSelection]);

  useEffect(() => {
    if (!hydrated || !activeConversationId) return;
    // The message listener above must be installed before this asks the worker
    // to replay a pending recovery. Otherwise an immediately replayed message
    // can be dropped during a side-panel remount.
    chrome.runtime.sendMessage({ action: 'GET_CONNECTIONS', payload: { clientId: clientIdRef.current, sessionId: activeConversationId } }, (response) => {
      if (response) setConnections(response as Record<AIProvider, AIConnection>);
    });
  }, [activeConversationId, hydrated]);

  // Persist the expanded trace after a run finishes. A controlled `open`
  // attribute tied only to isProcessing made completed failure details close on
  // every subsequent render.
  useEffect(() => {
    if (isProcessing) setTraceOpen(true);
  }, [isProcessing]);

  useEffect(() => {
    if (!hydrated || !activeConversationId) return;
    const next = commitActiveConversation(conversations, {
      id: activeConversationId,
      messages,
      mode,
      roles,
      providerUrls,
    }, t('session.untitled'));
    if (next !== conversations) setConversations(next);
    persistInputsRef.current = {
      conversations: next,
      activeConversationId,
      messages,
      mode,
      roles,
      providerUrls,
    };
    persisterRef.current?.track(toPersistPayload(next, activeConversationId));
    if (skipHydratePersistRef.current) {
      skipHydratePersistRef.current = false;
      return;
    }
    persisterRef.current?.debounce();
  }, [activeConversationId, hydrated, messages, mode, providerUrls, roles]);

  useEffect(() => {
    const flush = () => {
      if (!persistEnabledRef.current) return;
      const payload = payloadFromInputs(persistInputsRef.current, t('session.untitled'));
      if (!payload) return;
      persisterRef.current?.track(payload);
      persisterRef.current?.flush();
    };
    // Closing a panel destroys its document without a React unmount. Flush the
    // latest committed snapshot so mode/roles/active id agree with Free targets.
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const changeMode = (nextMode: ChatMode) => {
    if (isProcessing) return;
    setContextNeedsReplay(Boolean(messages.length));
    setMode(nextMode);
    setShowRoleConfig(false);
    const nextRoles = nextMode !== 'free'
      ? repairRoles(DEFAULT_ROLES[nextMode], standbyProvider)
      : persistInputsRef.current.roles;
    if (nextMode !== 'free') setRoles(nextRoles);
    persistInputsRef.current = { ...persistInputsRef.current, mode: nextMode, roles: nextRoles };
    const payload = payloadFromInputs(persistInputsRef.current, t('session.untitled'));
    if (!payload) return;
    persisterRef.current?.track(payload);
    persisterRef.current?.debounce();
  };

  const handleSend = useCallback((text: string) => {
    if (!text.trim() || isProcessing) return;
    const revision = ++conversationRevisionRef.current;
    if (activeWorkflowIdRef.current) ignoreWorkflow(activeWorkflowIdRef.current, ignoredWorkflowIdsRef);
    const workflowScope = createWorkflowScope(activeConversationId, clientIdRef.current);
    activeWorkflowIdRef.current = workflowScope.workflowId;
    const context = buildConversationReplayContext(messages, { includeAssistant: contextNeedsReplay });
    setMessages((current) => [...current, { id: `user-${crypto.randomUUID()}`, role: 'user', content: text, timestamp: Date.now() }]);
    setIsProcessing(true);
    setWorkflowStatus(null);
    stepRecoveryRef.current = null;
    setStepRecovery(null);
    resolvingRecoveryRef.current = false;
    setIsResolvingRecovery(false);
    clearPendingRoles(pendingRolesRef, setPendingRoles);
    setContextNeedsReplay(false);
    chrome.runtime.sendMessage({
      action: 'SEND_MESSAGE',
      payload: {
        ...workflowScope,
        text,
        context,
        mode,
        roles: mode === 'free' ? undefined : roles,
        targets: mode === 'free' ? freeTargets : undefined,
        recovery: autonomousRecovery,
      },
    }).then((response: { ok?: boolean; error?: string } | undefined) => {
      if (response?.ok === false) throw new Error(response.error ?? 'The workflow was not accepted');
    }).catch((error) => {
      if (conversationRevisionRef.current !== revision || activeWorkflowIdRef.current !== workflowScope.workflowId
        || activeConversationIdRef.current !== workflowScope.sessionId) return;
      activeWorkflowIdRef.current = undefined;
      setContextNeedsReplay(true);
      setMessages((current) => [...current, { id: `system-${crypto.randomUUID()}`, role: 'ai', provider: 'system' as AIProvider, content: `${ERROR_MARKER} ${String(error)}`, timestamp: Date.now() }]);
      setIsProcessing(false);
    });
  }, [activeConversationId, autonomousRecovery, contextNeedsReplay, freeTargets, isProcessing, messages, mode, roles]);

  const stopWorkflow = useCallback(() => {
    conversationRevisionRef.current += 1;
    const workflowId = activeWorkflowIdRef.current;
    if (workflowId) ignoreWorkflow(workflowId, ignoredWorkflowIdsRef);
    activeWorkflowIdRef.current = undefined;
    const cancellation = createWorkflowCancellation(activeConversationIdRef.current, clientIdRef.current, workflowId);
    if (cancellation) chrome.runtime.sendMessage({ action: 'CANCEL_WORKFLOW', payload: cancellation }).catch(() => {});
    setWorkflowStatus(null);
    stepRecoveryRef.current = null;
    setStepRecovery(null);
    resolvingRecoveryRef.current = false;
    setIsResolvingRecovery(false);
    clearPendingRoles(pendingRolesRef, setPendingRoles);
    setIsProcessing(false);
  }, []);

  const resolveStepRecovery = useCallback(async (action: StepRecoveryAction) => {
    const recovery = stepRecovery;
    if (!recovery || resolvingRecoveryRef.current) return;
    resolvingRecoveryRef.current = true;
    setIsResolvingRecovery(true);
    const decision: StepRecoveryDecision = {
      recoveryId: recovery.recoveryId,
      workflowId: recovery.workflowId,
      sessionId: recovery.sessionId,
      clientId: recovery.clientId,
      provider: recovery.provider,
      failedRequestId: recovery.failedRequestId,
      action,
    };
    try {
      const response = await chrome.runtime.sendMessage({ action: 'RESOLVE_STEP_RECOVERY', payload: decision }) as { ok?: boolean } | undefined;
      if (response?.ok) {
        ignoreRecovery(recovery.recoveryId, handledRecoveryIdsRef);
        setStepRecovery((current) => current?.recoveryId === recovery.recoveryId ? null : current);
        if (stepRecoveryRef.current?.recoveryId === recovery.recoveryId) stepRecoveryRef.current = null;
        return;
      }
    } catch {}
    resolvingRecoveryRef.current = false;
    setIsResolvingRecovery(false);
  }, [stepRecovery]);

  const closeDrawer = () => {
    setConversationDrawerOpen(false);
    setDeleteTargetId('');
  };

  const commitCurrentConversation = () => {
    const current = persistInputsRef.current;
    if (!current.activeConversationId) return current.conversations;
    return commitActiveConversation(current.conversations, {
      id: current.activeConversationId,
      messages: current.messages,
      mode: current.mode,
      roles: current.roles,
      providerUrls: current.providerUrls,
    }, t('session.untitled'));
  };

  const persistNow = (nextConversations: Conversation[], nextActiveId: string) => {
    persistInputsRef.current = { ...persistInputsRef.current, conversations: nextConversations, activeConversationId: nextActiveId };
    persisterRef.current?.track(toPersistPayload(nextConversations, nextActiveId));
    persisterRef.current?.flush();
  };

  const startNewConversation = () => {
    if (isProcessing) return;
    conversationRevisionRef.current += 1;
    if (activeWorkflowIdRef.current) ignoreWorkflow(activeWorkflowIdRef.current, ignoredWorkflowIdsRef);
    activeWorkflowIdRef.current = undefined;
    const committed = commitCurrentConversation();
    // notes: 已經有空對話就重用它，只更新時間，避免堆出一串重複的「新對話」
    const reusable = committed.find((candidate) => !candidate.messages?.length);
    const conversation = reusable ?? newConversation();
    const nextConversations = reusable
      ? committed.map((candidate) => candidate.id === reusable.id ? { ...candidate, updatedAt: Date.now() } : candidate)
      : [conversation, ...committed].slice(0, MAX_CONVERSATIONS);
    const nextRoles = repairRoles(DEFAULT_DEBATE_ROLES, standbyProvider);
    persistInputsRef.current = {
      conversations: nextConversations,
      activeConversationId: conversation.id,
      messages: [],
      mode: 'free',
      roles: nextRoles,
      providerUrls: {},
    };
    setConversations(nextConversations);
    setActiveConversationId(conversation.id);
    activeConversationIdRef.current = conversation.id;
    setMessages([]);
    setProviderUrls({});
    setContextNeedsReplay(false);
    setMode('free');
    setRoles(nextRoles);
    setTrace([]);
    setWorkflowStatus(null);
    stepRecoveryRef.current = null;
    setStepRecovery(null);
    resolvingRecoveryRef.current = false;
    setIsResolvingRecovery(false);
    clearPendingRoles(pendingRolesRef, setPendingRoles);
    closeDrawer();
    setConnectionsOpen(true);
    persistNow(nextConversations, conversation.id);
    // A cancelled or rejected send may have changed a provider conversation even
    // when it never produced an app transcript entry.
    chrome.runtime.sendMessage({ action: 'RESET_PROVIDER_SESSIONS', payload: { providers: activeProviders(standbyProviderRef.current) } }).catch(() => {});
  };

  const selectConversation = (conversation: Conversation) => {
    if (isProcessing) return;
    if (conversation.id === persistInputsRef.current.activeConversationId) return;
    conversationRevisionRef.current += 1;
    if (activeWorkflowIdRef.current) ignoreWorkflow(activeWorkflowIdRef.current, ignoredWorkflowIdsRef);
    activeWorkflowIdRef.current = undefined;
    const committed = commitCurrentConversation();
    const nextRoles = repairRoles(conversation.roles ?? (conversation.mode === 'free' ? DEFAULT_DEBATE_ROLES : DEFAULT_ROLES[conversation.mode]), standbyProvider);
    persistInputsRef.current = {
      conversations: committed,
      activeConversationId: conversation.id,
      messages: conversation.messages ?? [],
      mode: conversation.mode,
      roles: nextRoles,
      providerUrls: conversation.providerUrls ?? {},
    };
    setConversations(committed);
    setActiveConversationId(conversation.id);
    activeConversationIdRef.current = conversation.id;
    setMessages(conversation.messages ?? []);
    setProviderUrls(conversation.providerUrls ?? {});
    setContextNeedsReplay(Boolean(conversation.messages?.length));
    setMode(conversation.mode);
    setRoles(nextRoles);
    setTrace([]);
    persistNow(committed, conversation.id);
    const action = conversation.providerUrls && Object.keys(conversation.providerUrls).length
      ? { action: 'RESTORE_PROVIDER_SESSIONS', payload: { urls: conversation.providerUrls } }
      : { action: 'RESET_PROVIDER_SESSIONS', payload: { providers: activeProviders(standbyProviderRef.current) } };
    chrome.runtime.sendMessage(action).catch(() => {});
  };

  const deleteConversation = (id: string) => {
    if (isProcessing) return;
    const remaining = commitCurrentConversation().filter((conversation) => conversation.id !== id);
    setConversations(remaining);
    setDeleteTargetId('');
    persistInputsRef.current = {
      ...persistInputsRef.current,
      conversations: remaining,
      activeConversationId: id === persistInputsRef.current.activeConversationId ? '' : persistInputsRef.current.activeConversationId,
    };
    if (id !== activeConversationId) {
      persistNow(remaining, activeConversationId);
      return;
    }
    if (remaining.length) selectConversation(remaining[0]);
    else startNewConversation();
  };

  const changeLocale = (nextLocale: Locale) => {
    setActiveLocale(nextLocale);
    setLocale(nextLocale);
    void chrome.storage.local.set({ language: nextLocale });
  };

  const changeTheme = (nextTheme: ThemeMode) => {
    setTheme(nextTheme);
    void chrome.storage.local.set({ theme: nextTheme });
  };

  const changeAutonomousRecovery = (next: AutonomousRecoverySettings) => {
    const normalized = normalizeAutonomousRecoverySettings(next);
    setAutonomousRecovery(normalized);
    void chrome.storage.local.set({ autonomousRecovery: normalized });
  };

  const changeStandbyProvider = async (next: AIProvider) => {
    const result = await chrome.runtime.sendMessage({
      action: 'SET_STANDBY_PROVIDER', payload: { standbyProvider: next },
    }) as { ok?: boolean; error?: string; standbyProvider?: AIProvider; freeTargets?: AIProvider[] } | undefined;
    if (!result?.ok || !result.standbyProvider) throw new Error(humanizeError(result?.error ?? t('error.provider_change_failed')));
    applyProviderSelection(result.standbyProvider, result.freeTargets);
  };

  const toggleTarget = (provider: AIProvider) => {
    if (isProcessing) return;
    setContextNeedsReplay(Boolean(messages.length));
    setFreeTargets((current) => {
      const next = current.includes(provider) ? current.filter((candidate) => candidate !== provider) : [...current, provider];
      const safeNext = next.length ? next : [provider];
      void chrome.storage.local.set({ freeTargets: safeNext });
      return safeNext;
    });
  };

  const selectReadyTargets = () => {
    if (!hydrated || isProcessing || mode !== 'free') return;
    const targets = readyActiveTargets(connections, standbyProviderRef.current);
    if (!targets.length) return;
    setContextNeedsReplay(Boolean(messages.length));
    setFreeTargets(targets);
    void chrome.storage.local.set({ freeTargets: targets });
  };

  const changeRoles = (nextRoles: ModeRoles) => {
    if (isProcessing) return;
    setRoles(nextRoles);
    setContextNeedsReplay(Boolean(messages.length));
  };

  const openLogin = async (provider: AIProvider): Promise<void> => {
    const response = await chrome.runtime.sendMessage({ action: 'OPEN_LOGIN', provider }) as { ok?: boolean; error?: string } | undefined;
    if (response && response.ok === false) throw new Error(response.error ?? provider);
  };

  const connectAll = () => {
    const pending = providers.filter((provider) => connections[provider].status !== 'connected');
    Promise.all(pending.map(openLogin))
      .then(() => setConnectionsOpen(false))
      .catch(() => {});
  };

  const exportConversation = () => {
    if (!messages.length) return;
    const { content } = buildMarkdown(messages, mode);
    const blobUrl = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = `multi-ai-chat-${mode}-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.md`;
    anchor.click();
    URL.revokeObjectURL(blobUrl);
  };

  const publishConversation = async () => {
    if (!messages.length) return alert(t('publish.empty'));
    const token = await getHackMDToken();
    if (!token) {
      alert(t('publish.no_token'));
      setIsSettingsOpen(true);
      return;
    }
    setIsPublishing(true);
    try {
      const { title, content } = buildMarkdown(messages, mode);
      const { publishLink } = await publishToHackMD(`${title} — ${new Date().toLocaleString()}`, content, token);
      await navigator.clipboard.writeText(publishLink).catch(() => {});
      alert(`${t('publish.success')}\n\n${publishLink}`);
      window.open(publishLink, '_blank', 'noopener,noreferrer');
    } catch (error) {
      alert(`${t('publish.failed')} ${humanizeError(String(error))}`);
    } finally {
      setIsPublishing(false);
    }
  };

  const connectedCount = readyActiveTargets(connections, standbyProvider).length;
  const readiness = getProviderReadiness(mode, mode === 'free'
    ? selectedActiveTargets(freeTargets, standbyProvider)
    : Object.values(roles), connections);
  const readinessNotice = hydrated && !isProcessing && readiness.noticeKey ? t(readiness.noticeKey, {
    providers: readiness.unready.map((provider) => AI_PROVIDERS[provider].name).join(' · '),
    ready: readiness.ready.map((provider) => AI_PROVIDERS[provider].name).join(' · '),
  }) : undefined;
  const failedUnready = failedOpenProviders.filter((provider) => readiness.unready.includes(provider));
  const readinessOpenError = failedUnready.length ? t('error.open_unready_failed', {
    providers: failedUnready.map((provider) => AI_PROVIDERS[provider].name).join(' · '),
  }) : undefined;
  const handleOpenUnready = async () => {
    if (!hydrated || isProcessing || openingUnreadyRef.current) return;
    openingUnreadyRef.current = true;
    setIsOpeningUnready(true);
    setFailedOpenProviders([]);
    setConnectionsOpen(true);
    try {
      setFailedOpenProviders(await openUnreadyProviders(readiness.unready, standbyProviderRef.current, connections, openLogin));
    } finally {
      openingUnreadyRef.current = false;
      setIsOpeningUnready(false);
    }
  };
  const currentStatus = workflowStatus ? formatWorkflowStatus(workflowStatus) : t('trace.idle');

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="flex-none border-b border-slate-200 bg-white px-3 py-2.5">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => conversationDrawerOpen ? closeDrawer() : setConversationDrawerOpen(true)} className="rounded-lg hover:bg-slate-100" title={t('app.menu')} aria-label={t('app.menu')} aria-expanded={conversationDrawerOpen}><BrandMark /></button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-bold text-slate-900">{t('app.title')}</h1>
            <p className="truncate text-xs text-slate-500">{t('app.subtitle')}</p>
          </div>
          <span className="shrink-0 whitespace-nowrap rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">{connectedCount}/4 {t('app.connected')}</span>
          <button type="button" onClick={() => setIsSettingsOpen(true)} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-300 text-xl leading-none text-slate-700 hover:bg-slate-100" title={t('app.settings')} aria-label={t('app.settings')}>⚙</button>
        </div>
      </header>

      <section className="min-h-0 max-h-[46vh] flex-none overflow-y-auto overscroll-contain border-b border-slate-200 bg-white px-3 py-3">
        <ModeSelector mode={mode} onModeChange={changeMode} disabled={isProcessing} />

        {mode === 'free' && (
          <div role="group" aria-label={t('targets.title')} className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t('targets.title')}</div>
              <button type="button" onClick={selectReadyTargets} disabled={!hydrated || isProcessing || connectedCount === 0}
                title={connectedCount === 0 ? t('targets.none_ready') : undefined}
                className="rounded-lg border border-sky-300 bg-sky-50 px-2 py-1 text-[11px] font-semibold text-sky-800 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50">{t('targets.select_ready')}</button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {providers.map((provider) => {
                const selected = freeTargets.includes(provider);
                const ready = connections[provider].status === 'connected';
                return <button key={provider} type="button" aria-pressed={selected} disabled={isProcessing} onClick={() => toggleTarget(provider)} className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${selected ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-slate-200 bg-white text-slate-400'}`}><span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-500' : 'bg-slate-300'}`} />{AI_PROVIDERS[provider].name}</button>;
              })}
            </div>
          </div>
        )}

        {mode !== 'free' && (
          <div className="mt-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="min-w-0 break-words text-[11px] leading-relaxed text-slate-600">
                {Object.entries(roles as unknown as Record<string, AIProvider>).map(([role, provider]) => `${t(`role.${role}`)}: ${AI_PROVIDERS[provider].name}`).join(' · ')}
              </p>
              {mode !== 'debate' && <button type="button" onClick={() => setShowRoleConfig((current) => !current)} className="shrink-0 text-xs font-medium text-sky-700 hover:text-sky-900">{showRoleConfig ? t('roles.toggle.hide') : t('roles.toggle.show')}</button>}
            </div>
            {((mode === 'debate') || showRoleConfig) && <RoleConfig providers={providers} mode={mode} roles={roles} onRolesChange={changeRoles} disabled={!hydrated || isProcessing} />}
          </div>
        )}

        <details className="mt-2 rounded-lg border border-slate-200 bg-slate-50" open={connectionsOpen} onToggle={(event) => setConnectionsOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-700">
            {t('connection.title')}
            {/* notes: float keeps the native ▸ marker; display:flex on summary would drop it */}
            <button type="button" onClick={(event) => { event.preventDefault(); connectAll(); }} disabled={connectedCount === 4} className="float-right rounded-lg bg-sky-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500">{t('connection.connect_all')}</button>
          </summary>
          <div className="border-t border-slate-200 p-2.5">
            <ConnectionBar providers={providers} connections={connections} onOpenLogin={(provider) => { void openLogin(provider).catch(() => {}); }} />
            <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('connection.help')}</p>
          </div>
        </details>

        <details className="mt-2 rounded-lg border border-slate-200 bg-white" open={isProcessing || traceOpen} onToggle={(event) => setTraceOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-700"><span className={`mr-2 inline-block h-2 w-2 rounded-full ${isProcessing ? 'animate-pulse bg-sky-500' : 'bg-emerald-500'}`} />{t('trace.title')} · <span className="font-normal text-slate-500">{currentStatus}</span></summary>
          {workflowStatus?.progress && <div className="border-t border-slate-100 px-2.5 py-1.5 text-[11px] text-slate-600">
            {t('workflow.progress', { completed: workflowStatus.progress.completed, total: workflowStatus.progress.total, attempts: workflowStatus.progress.recoveryAttempts })}
            {workflowStatus.progress.lastCheckpointAt && <span className="ml-2 text-slate-400">{t('workflow.checkpoint', { time: new Date(workflowStatus.progress.lastCheckpointAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</span>}
          </div>}
          {trace.length > 0 && <div className="space-y-1 border-t border-slate-200 p-2.5">{trace.map((entry) => <div key={entry.id} className="break-words text-[11px] leading-relaxed text-slate-600">{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {entry.text}</div>)}</div>}
          {stepRecovery && (
            <div role="alert" className="border-t border-amber-200 bg-amber-50 p-2.5">
              <div className="text-xs font-semibold text-amber-900">{t('recovery.title', { provider: AI_PROVIDERS[stepRecovery.provider].name })}</div>
              {stepRecovery.failureKind && <div className="mt-1 text-[11px] font-medium text-amber-900">{t(`recovery.failure.${stepRecovery.failureKind}`)}</div>}
              <div className="mt-1 break-words text-[11px] leading-relaxed text-amber-800">{humanizeError(stepRecovery.reason)}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" disabled={isResolvingRecovery || stepRecovery.retryAllowed === false} onClick={() => void resolveStepRecovery('retry')} className="rounded-lg bg-sky-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-sky-800 disabled:opacity-50">{t('recovery.retry')}</button>
                <button type="button" disabled={isResolvingRecovery} onClick={() => void resolveStepRecovery('skip')} className="rounded-lg border border-amber-400 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50">{t('recovery.skip')}</button>
                <button type="button" disabled={isResolvingRecovery} onClick={() => void resolveStepRecovery('cancel')} className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50">{t('recovery.cancel')}</button>
              </div>
            </div>
          )}
        </details>
      </section>

      <ChatArea messages={messages} mode={mode} conversationId={activeConversationId} />

      <div className="flex-none border-t border-slate-200 bg-white px-3 py-1.5">
        <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs text-slate-500">
          <button type="button" onClick={startNewConversation} disabled={isProcessing} className="hover:text-sky-700 disabled:opacity-30">{t('app.new')}</button>
          <button type="button" onClick={exportConversation} disabled={!messages.length} className="hover:text-sky-700 disabled:opacity-30">{t('app.export')}</button>
          <button type="button" onClick={() => void publishConversation()} disabled={!messages.length || isPublishing} className="hover:text-sky-700 disabled:opacity-30">{isPublishing ? t('publish.publishing') : t('app.publish')}</button>
        </div>
      </div>
      <InputBar onSend={handleSend} onCancel={stopWorkflow} disabled={!hydrated || isProcessing || !readiness.canSend}
        isProcessing={isProcessing} readinessNotice={readinessNotice}
        onOpenUnready={readiness.unready.length ? () => { void handleOpenUnready(); } : undefined}
        isOpeningUnready={isOpeningUnready} readinessOpenError={readinessOpenError} />

      {conversationDrawerOpen && (
        <div className="absolute inset-0 z-40 bg-black/30" onClick={closeDrawer}>
          <aside className="flex h-full w-[86%] max-w-sm flex-col border-r border-slate-200 bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-slate-200 p-3">
              <BrandMark />
              <h2 className="flex-1 text-sm font-semibold">{t('session.history')}</h2>
              <button type="button" onClick={closeDrawer} className="rounded-sm px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">{t('app.close')}</button>
            </div>
            <div className="p-3"><button type="button" disabled={isProcessing} onClick={startNewConversation} className="w-full rounded-xl border border-sky-300 bg-sky-50 px-3 py-2 text-left text-sm font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50">＋ {t('app.new')}</button></div>
            <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
              {conversations.length === 0 && <p className="p-3 text-xs text-slate-500">{t('session.empty')}</p>}
              {conversations.map((conversation) => (
                <div key={conversation.id} className="flex items-center gap-1">
                  <button type="button" disabled={isProcessing} onClick={() => { selectConversation(conversation); setDeleteTargetId(conversation.id); }} className={`min-w-0 flex-1 rounded-lg px-3 py-2 text-left ${conversation.id === activeConversationId ? 'bg-sky-50 text-sky-900' : 'text-slate-700 hover:bg-slate-50'}`}>
                    <span className="block truncate text-xs font-medium">{conversation.title || t('session.untitled')}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-400">{new Date(conversation.updatedAt || conversation.createdAt).toLocaleString()}</span>
                  </button>
                  {deleteTargetId === conversation.id && <button type="button" disabled={isProcessing} onClick={() => deleteConversation(conversation.id)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-red-300 bg-red-50 text-sm font-bold text-red-700 hover:bg-red-100 disabled:opacity-40" title={t('session.delete')} aria-label={t('session.delete')}>✕</button>}
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}

      <SettingsModal isOpen={isSettingsOpen} locale={locale} onLocaleChange={changeLocale} theme={theme} onThemeChange={changeTheme} autonomousRecovery={autonomousRecovery} onAutonomousRecoveryChange={changeAutonomousRecovery} standbyProvider={standbyProvider} onStandbyChange={changeStandbyProvider} providerSelectionDisabled={!hydrated || isProcessing} onClose={() => setIsSettingsOpen(false)} />
    </div>
  );
}

function BrandMark() {
  return <span className="grid h-8 w-8 shrink-0 grid-cols-2 gap-0.5 rounded-lg bg-slate-50 p-1.5" aria-hidden="true"><span className="rounded-full bg-sky-500" /><span className="rounded-full bg-rose-500" /><span className="rounded-full bg-amber-400" /><span className="rounded-full bg-emerald-500" /></span>;
}

function upsertStreamingMessage(
  messages: ChatMessage[],
  provider: AIProvider,
  requestId: string | undefined,
  content: string,
  pendingRolesRef: React.MutableRefObject<Record<string, string>>,
  setPendingRoles: React.Dispatch<React.SetStateAction<Record<string, string>>>,
): ChatMessage[] {
  if (requestId && messages.some(message => message.requestId === requestId && !message.id.endsWith('-streaming'))) return messages;
  const existing = messages.find((message) => message.requestId === requestId && message.id.endsWith('-streaming'));
  if (existing) return messages.map((message) => message.id === existing.id ? { ...message, content } : message);
  const modeRole = consumePendingRole(provider, requestId, pendingRolesRef, setPendingRoles);
  return [...messages, { id: `${requestId ?? crypto.randomUUID()}-streaming`, role: 'ai', provider, modeRole, content, timestamp: Date.now(), requestId }];
}

function finalizeMessage(
  messages: ChatMessage[],
  provider: AIProvider,
  requestId: string | undefined,
  content: string,
  pendingRolesRef: React.MutableRefObject<Record<string, string>>,
  setPendingRoles: React.Dispatch<React.SetStateAction<Record<string, string>>>,
): ChatMessage[] {
  if (requestId && messages.some(message => message.requestId === requestId && !message.id.endsWith('-streaming'))) return messages;
  const existing = messages.find((message) => message.requestId === requestId && message.id.endsWith('-streaming'));
  if (existing) return messages.map((message) => message.id === existing.id ? { ...message, id: message.id.replace(/-streaming$/, ''), content } : message);
  const modeRole = consumePendingRole(provider, requestId, pendingRolesRef, setPendingRoles);
  return [...messages, { id: requestId ?? crypto.randomUUID(), role: 'ai', provider, modeRole, content, timestamp: Date.now(), requestId }];
}

function consumePendingRole(
  provider: AIProvider,
  requestId: string | undefined,
  pendingRolesRef: React.MutableRefObject<Record<string, string>>,
  setPendingRoles: React.Dispatch<React.SetStateAction<Record<string, string>>>,
): string | undefined {
  const key = requestId && pendingRolesRef.current[requestId] ? requestId : provider;
  const role = pendingRolesRef.current[key];
  if (!role) return undefined;
  setPendingRoles((current) => {
    const next = { ...current };
    delete next[key];
    pendingRolesRef.current = next;
    return next;
  });
  return role;
}

function discardPendingRole(
  requestId: string,
  pendingRolesRef: React.MutableRefObject<Record<string, string>>,
  setPendingRoles: React.Dispatch<React.SetStateAction<Record<string, string>>>,
): void {
  if (!pendingRolesRef.current[requestId]) return;
  setPendingRoles((current) => {
    const next = { ...current };
    delete next[requestId];
    pendingRolesRef.current = next;
    return next;
  });
}

function clearPendingRoles(
  pendingRolesRef: React.MutableRefObject<Record<string, string>>,
  setPendingRoles: React.Dispatch<React.SetStateAction<Record<string, string>>>,
): void {
  pendingRolesRef.current = {};
  setPendingRoles({});
}

function ignoreWorkflow(workflowId: string, ignoredWorkflowIdsRef: React.MutableRefObject<Set<string>>): void {
  const ignored = ignoredWorkflowIdsRef.current;
  ignored.add(workflowId);
  while (ignored.size > 100) {
    const oldest = ignored.values().next().value as string | undefined;
    if (!oldest) break;
    ignored.delete(oldest);
  }
}

function completeWorkflow(workflowId: string, completedWorkflowIdsRef: React.MutableRefObject<Set<string>>): void {
  const completed = completedWorkflowIdsRef.current;
  completed.add(workflowId);
  while (completed.size > 100) {
    const oldest = completed.values().next().value as string | undefined;
    if (!oldest) break;
    completed.delete(oldest);
  }
}

function ignoreRequest(requestId: string, ignoredRequestIdsRef: React.MutableRefObject<Set<string>>): void {
  const ignored = ignoredRequestIdsRef.current;
  ignored.add(requestId);
  while (ignored.size > 200) {
    const oldest = ignored.values().next().value as string | undefined;
    if (!oldest) break;
    ignored.delete(oldest);
  }
}

function ignoreRecovery(recoveryId: string, handledRecoveryIdsRef: React.MutableRefObject<Set<string>>): void {
  const handled = handledRecoveryIdsRef.current;
  handled.add(recoveryId);
  while (handled.size > 200) {
    const oldest = handled.values().next().value as string | undefined;
    if (!oldest) break;
    handled.delete(oldest);
  }
}
