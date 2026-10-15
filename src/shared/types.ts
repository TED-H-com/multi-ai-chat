import type { SubmissionEvidence } from './autonomousRecovery';

// === AI Providers ===

export type AIProvider = 'chatgpt' | 'claude' | 'gemini' | 'grok' | 'meta';
export type Locale = 'en' | 'zh-TW' | 'ja' | 'de' | 'ko';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface AIConnection {
  provider: AIProvider;
  status: 'connected' | 'disconnected' | 'checking' | 'login-required';
  tabId?: number;
}

// === Chat Modes ===

export type ChatMode = 'free' | 'debate' | 'consult' | 'coding' | 'roundtable';

// 四方辯證
export interface DebateRoles {
  pro: AIProvider;      // 正方
  con: AIProvider;      // 反方
  judge: AIProvider;    // 判官（評論雙方論點強弱）
  summary: AIProvider;  // 總結
}

// 多方諮詢
export interface ConsultRoles {
  first: AIProvider;    // 先答 A
  second: AIProvider;   // 先答 B
  reviewer: AIProvider; // 審查
  summary: AIProvider;  // 總結
}

// Coding 模式
export interface CodingRoles {
  planner: AIProvider;  // 規劃者
  reviewer: AIProvider; // 審查者
  coder: AIProvider;    // 執行+品管
  tester: AIProvider;   // 測試員（出測試案例 + 挑 bug）
}

// 道理辯證 (5 rounds × 4 人)
export interface RoundtableRoles {
  first: AIProvider;   // 每輪第一位發言
  second: AIProvider;  // 每輪第二位發言
  third: AIProvider;   // 每輪第三位發言
  fourth: AIProvider;  // 每輪第四位發言
}

export type ModeRoles = DebateRoles | ConsultRoles | CodingRoles | RoundtableRoles;

// === Messages ===

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  provider?: AIProvider;
  modeRole?: string; // 'pro' | 'con' | 'summary' | 'first' | 'reviewer' | 'planner' | 'coder' etc.
  content: string;
  timestamp: number;
  requestId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  mode: ChatMode;
  roles?: ModeRoles;
  messages: ChatMessage[];
  providerUrls?: Partial<Record<AIProvider, string>>;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStatusPayload {
  key: string;
  params?: Record<string, string | number>;
  workflowId?: string;
  sessionId?: string;
  clientId?: string;
  done?: boolean;
  cancelled?: boolean;
  progress?: {
    completed: number;
    total: number;
    recoveryAttempts: number;
    lastCheckpointAt?: number;
  };
}

// Lifecycle telemetry intentionally carries only routing and state metadata.
// It never contains prompts, provider response text, cookies, or credentials.
export interface WorkflowDiagnosticPayload {
  workflowId: string;
  turnId: string;
  provider: AIProvider;
  stage: string;
  requestId?: string;
  role?: string;
  attempt?: number;
  submission?: SubmissionEvidence;
  failureKind?: ProviderFailureKind;
  // Encoded error keys and aggregate page observations are safe to display in
  // the developer trace. They must never include prompt or response text.
  failureCode?: string;
  responseLength?: number;
  responseCandidateCount?: number;
  semanticResponseCandidateCount?: number;
  currentResponseLength?: number;
  generationObserved?: boolean;
  sessionId?: string;
  clientId?: string;
}

export type StepRecoveryAction = 'retry' | 'skip' | 'cancel';

export type AutonomousRecoveryPolicy = 'safe' | 'strict' | 'best-effort';

export interface AutonomousRecoverySettings {
  enabled: boolean;
  policy: AutonomousRecoveryPolicy;
}

// This is deliberately a small, sanitized classification. It is safe to show in
// the side panel and lets recovery diagnostics identify the failed stage without
// serializing prompts, provider responses, or browser-session data.
export type ProviderFailureKind =
  | 'prompt_insertion'
  | 'submission'
  | 'response_timeout'
  | 'response_extraction'
  | 'authentication'
  | 'quota_or_rate_limit'
  | 'navigation'
  | 'unexpected';

export interface StepRecoveryRequest {
  recoveryId: string;
  workflowId: string;
  sessionId: string;
  clientId: string;
  provider: AIProvider;
  failedRequestId: string;
  reason: string;
  failureKind?: ProviderFailureKind;
  // A retry is disabled when Send may already have been accepted. Skipping or
  // cancelling remains available, but the extension must never replay it.
  retryAllowed?: boolean;
}

export interface StepRecoveryDecision {
  recoveryId: string;
  workflowId: string;
  sessionId: string;
  clientId: string;
  provider: AIProvider;
  failedRequestId: string;
  action: StepRecoveryAction;
}

// === Chrome Message Passing ===

export type MessageAction =
  | 'CHECK_STATUS'
  | 'STATUS_REPORT'
  | 'SEND_MESSAGE'
  | 'RESPONSE_CHUNK'
  | 'RESPONSE_DONE'
  | 'OPEN_LOGIN'
  | 'GET_CONNECTIONS'
  | 'SET_STANDBY_PROVIDER'
  | 'PROVIDER_SELECTION_UPDATE'
  | 'GET_PROVIDER_URLS'
  | 'RESET_PROVIDER_SESSIONS'
  | 'RESTORE_PROVIDER_SESSIONS'
  | 'CONNECTIONS_UPDATE'
  | 'WORKFLOW_STATUS'
  | 'WORKFLOW_DIAGNOSTIC'
  | 'ROLE_ASSIGNMENT'
  | 'STEP_RECOVERY_REQUIRED'
  | 'STEP_RECOVERY_PRESENTED'
  | 'RESOLVE_STEP_RECOVERY'
  | 'PROVIDER_REQUEST_STATE'
  | 'QUERY_PROVIDER_REQUEST_STATE'
  | 'CANCEL_WORKFLOW'
  | 'STOP_GENERATION'
  | 'PUBLISH_HACKMD';

export interface ExtensionMessage {
  action: MessageAction;
  provider?: AIProvider;
  requestId?: string;
  workflowId?: string;
  payload?: unknown;
}
