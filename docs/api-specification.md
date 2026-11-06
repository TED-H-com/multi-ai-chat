# API Specification

This document details the extension's core messaging API and data types, as defined in `src/shared/types.ts`.

## Core Types

### AIProvider
`'chatgpt' | 'claude' | 'gemini' | 'grok' | 'meta'`

### ChatMode
`'free' | 'debate' | 'consult' | 'coding' | 'roundtable'`

### ModeRoles
Roles are specific to the selected ChatMode.
- **DebateRoles**: `pro`, `con`, `judge`, `summary`
- **ConsultRoles**: `first`, `second`, `reviewer`, `summary`
- **CodingRoles**: `planner`, `reviewer`, `coder`, `tester`
- **RoundtableRoles**: `first`, `second`, `third`, `fourth`

### MessageAction
The system coordinates via Chrome message passing (`chrome.runtime.sendMessage` and `chrome.runtime.onMessage`). Valid `MessageAction`s are:
- `CHECK_STATUS`
- `STATUS_REPORT`
- `SEND_MESSAGE`
- `RESPONSE_CHUNK`
- `RESPONSE_DONE`
- `OPEN_LOGIN`
- `GET_CONNECTIONS`
- `SET_STANDBY_PROVIDER`
- `PROVIDER_SELECTION_UPDATE`
- `GET_PROVIDER_URLS`
- `RESET_PROVIDER_SESSIONS`
- `RESTORE_PROVIDER_SESSIONS`
- `CONNECTIONS_UPDATE`
- `WORKFLOW_STATUS`
- `WORKFLOW_DIAGNOSTIC`
- `ROLE_ASSIGNMENT`
- `STEP_RECOVERY_REQUIRED`
- `STEP_RECOVERY_PRESENTED`
- `RESOLVE_STEP_RECOVERY`
- `PROVIDER_REQUEST_STATE`
- `QUERY_PROVIDER_REQUEST_STATE`
- `CANCEL_WORKFLOW`
- `STOP_GENERATION`
- `PUBLISH_HACKMD`

## Core Payload Interfaces

### ExtensionMessage
The standard envelope for all cross-script messages.
```typescript
interface ExtensionMessage {
  action: MessageAction;
  provider?: AIProvider;
  requestId?: string;
  workflowId?: string;
  payload?: unknown;
}
```

### WorkflowStatusPayload
Used for communicating the progress of a workflow run.
```typescript
interface WorkflowStatusPayload {
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
```

### WorkflowDiagnosticPayload
Lifecycle telemetry carrying routing and state metadata. Must never contain prompts, provider response text, cookies, or credentials.
```typescript
interface WorkflowDiagnosticPayload {
  workflowId: string;
  turnId: string;
  provider: AIProvider;
  stage: string;
  requestId?: string;
  role?: string;
  attempt?: number;
  submission?: SubmissionEvidence;
  failureKind?: ProviderFailureKind;
  failureCode?: string;
  responseLength?: number;
  responseCandidateCount?: number;
  semanticResponseCandidateCount?: number;
  currentResponseLength?: number;
  generationObserved?: boolean;
  sessionId?: string;
  clientId?: string;
}
```

### StepRecoveryRequest
Issued when a workflow turn fails and requires fallback routing.
```typescript
interface StepRecoveryRequest {
  recoveryId: string;
  workflowId: string;
  sessionId: string;
  clientId: string;
  provider: AIProvider;
  failedRequestId: string;
  reason: string;
  failureKind?: ProviderFailureKind;
  retryAllowed?: boolean;
}
```
