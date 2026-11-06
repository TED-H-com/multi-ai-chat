import type { AIProvider, ChatMessage, ChatMode, Conversation, ModeRoles } from './types';

export const MAX_CONVERSATIONS = 30;
const MAX_CONVERSATION_STORAGE_BYTES = 7_500_000;

export interface ConversationPersistPayload {
  conversations: Conversation[];
  activeConversationId: string;
}

export interface ConversationPersistInputs {
  conversations: Conversation[];
  activeConversationId: string;
  messages: ChatMessage[];
  mode: ChatMode;
  roles: ModeRoles;
  providerUrls: Partial<Record<AIProvider, string>>;
}

export interface ConversationPersister {
  track(payload: ConversationPersistPayload | null): void;
  enable(): void;
  debounce(): void;
  flush(): void;
  peek(): ConversationPersistPayload | null;
}

export function prepareNewConversation(
  conversations: Conversation[],
  mode: ChatMode,
  roles: ModeRoles,
  untitled: string,
  createId: () => string = () => crypto.randomUUID(),
  now = Date.now(),
): { conversation: Conversation; conversations: Conversation[] } {
  const reusable = conversations.find(candidate => !candidate.messages?.length);
  const conversation: Conversation = {
    id: reusable?.id ?? createId(),
    title: untitled,
    mode,
    roles: mode === 'free' ? undefined : { ...roles },
    messages: [],
    providerUrls: {},
    createdAt: reusable?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    conversation,
    conversations: reusable
      ? conversations.map(candidate => candidate.id === conversation.id ? conversation : candidate)
      : [conversation, ...conversations].slice(0, MAX_CONVERSATIONS),
  };
}

export function storageReadFailed(lastError: { message?: string } | undefined | null): boolean {
  return Boolean(lastError?.message);
}

export function conversationTitle(messages: readonly ChatMessage[], untitled: string): string {
  const firstQuestion = messages.find((message) => message.role === 'user')?.content.trim();
  if (!firstQuestion) return untitled;
  return firstQuestion.length > 46 ? `${firstQuestion.slice(0, 46)}…` : firstQuestion;
}

export function usableConversations(raw: unknown): Conversation[] {
  if (!Array.isArray(raw)) return [];
  const usable: Conversation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const conversation = entry as Conversation;
    if (typeof conversation.id !== 'string' || !conversation.id) continue;
    if (conversation.messages == null) {
      usable.push(conversation);
      continue;
    }
    if (!Array.isArray(conversation.messages)) continue;
    const messages = conversation.messages.filter((message): message is ChatMessage => (
      Boolean(message)
      && typeof message === 'object'
      && typeof (message as ChatMessage).id === 'string'
    ));
    if (messages.length === conversation.messages.length) usable.push(conversation);
    else usable.push({ ...conversation, messages });
  }
  return usable;
}

export function commitActiveConversation(
  conversations: Conversation[],
  active: {
    id: string;
    messages: readonly ChatMessage[];
    mode: ChatMode;
    roles: ModeRoles;
    providerUrls: Partial<Record<AIProvider, string>>;
  },
  untitled: string,
  now = Date.now(),
): Conversation[] {
  if (!active.id) return conversations;
  const existing = conversations.find((conversation) => conversation.id === active.id);
  const next: Conversation = {
    id: active.id,
    title: conversationTitle(active.messages, untitled),
    mode: active.mode,
    roles: active.mode === 'free' ? undefined : active.roles,
    messages: Array.isArray(active.messages) ? [...active.messages] : [],
    providerUrls: active.providerUrls,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing && sameConversationContent(existing, next)) return conversations;
  return [next, ...conversations.filter((conversation) => conversation.id !== active.id)]
    .sort((first, second) => second.updatedAt - first.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
}

export function toPersistPayload(
  conversations: Conversation[],
  activeConversationId: string,
): ConversationPersistPayload {
  return {
    conversations: fitConversationsForStorage(conversations),
    activeConversationId,
  };
}

export function payloadFromInputs(
  inputs: ConversationPersistInputs,
  untitled: string,
  now = Date.now(),
): ConversationPersistPayload | null {
  if (!inputs.activeConversationId) return null;
  return toPersistPayload(commitActiveConversation(inputs.conversations, {
    id: inputs.activeConversationId,
    messages: inputs.messages,
    mode: inputs.mode,
    roles: inputs.roles,
    providerUrls: inputs.providerUrls,
  }, untitled, now), inputs.activeConversationId);
}

export function fitConversationsForStorage(conversations: Conversation[]): Conversation[] {
  const persisted = [...conversations];
  const size = () => new TextEncoder().encode(JSON.stringify(persisted)).byteLength;
  while (persisted.length > 1 && size() > MAX_CONVERSATION_STORAGE_BYTES) persisted.pop();
  if (persisted.length === 1 && size() > MAX_CONVERSATION_STORAGE_BYTES) {
    const conversation = { ...persisted[0], messages: [...persisted[0].messages] };
    while (conversation.messages.length > 2 && new TextEncoder().encode(JSON.stringify(conversation)).byteLength > MAX_CONVERSATION_STORAGE_BYTES) {
      conversation.messages.shift();
    }
    persisted[0] = conversation;
  }
  return persisted;
}

export function createConversationPersister(options: {
  write: (payload: ConversationPersistPayload) => void | Promise<void>;
  delayMs?: number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
}): ConversationPersister {
  const delayMs = options.delayMs ?? 350;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelTimer = options.cancel ?? ((id) => clearTimeout(id));
  let enabled = false;
  let latest: ConversationPersistPayload | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function track(payload: ConversationPersistPayload | null): void {
    latest = payload;
  }

  function enable(): void {
    enabled = true;
  }

  function debounce(): void {
    if (!enabled || !latest) return;
    if (timer !== undefined) cancelTimer(timer);
    timer = schedule(() => {
      timer = undefined;
      flush();
    }, delayMs);
  }

  function flush(): void {
    if (timer !== undefined) {
      cancelTimer(timer);
      timer = undefined;
    }
    if (!enabled || !latest) return;
    try {
      const result = options.write(latest);
      if (result && typeof result.then === 'function') void result.catch(() => {});
    } catch {
      // Quota / shutdown failures must not surface as unhandled rejections.
    }
  }

  return { track, enable, debounce, flush, peek: () => latest };
}

function sameConversationContent(existing: Conversation, next: Conversation): boolean {
  return existing.title === next.title
    && existing.mode === next.mode
    && JSON.stringify(existing.roles) === JSON.stringify(next.roles)
    && JSON.stringify(existing.messages) === JSON.stringify(next.messages)
    && JSON.stringify(existing.providerUrls ?? {}) === JSON.stringify(next.providerUrls ?? {});
}
