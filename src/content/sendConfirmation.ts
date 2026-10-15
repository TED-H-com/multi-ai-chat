export function clearedComposerConfirmsSend(
  activatedInput: unknown,
  currentInput: unknown,
  requireSameComposer: boolean,
  hasNewUserMessage: boolean,
): boolean {
  return hasNewUserMessage
    || !requireSameComposer
    || (activatedInput !== undefined && activatedInput === currentInput);
}

export function contentMatchesPrompt(content: string, prompt: string): boolean {
  const expected = normalizeFormattingWhitespace(prompt);
  if (!expected) return false;
  if (normalizeFormattingWhitespace(content) === expected) return true;
  const renderedPrompt = visibleMarkdownKey(prompt);
  return Boolean(renderedPrompt) && visibleMarkdownKey(content) === renderedPrompt;
}

function visibleMarkdownKey(value: string): string {
  return normalizeFormattingWhitespace(value
    .normalize('NFKC')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}`{3,}[^`\r\n]*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(?<![\p{L}\p{N}*_])(\*\*|__)(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}*_])/gu, '$2')
    .replace(/(?<![\p{L}\p{N}*])\*(?=\S)([^*\r\n]*?\S)\*(?![\p{L}\p{N}*])/gu, '$1')
    .replace(/(`+)([^`\r\n]+)\1/g, '$2'));
}

function normalizeFormattingWhitespace(value: string): string {
  // Quoted source can contain meaningful spaces. Only surrounding formatting
  // whitespace is collapsed, and word boundaries are never removed.
  const literals = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
  let result = '';
  let end = 0;
  for (const match of value.matchAll(literals)) {
    result += value.slice(end, match.index).replace(/\s+/g, ' ') + match[0];
    end = match.index + match[0].length;
  }
  return (result + value.slice(end).replace(/\s+/g, ' ')).trim();
}

export function matchingPromptCount(messageTexts: readonly string[], prompt: string): number {
  return messageTexts.reduce(
    (count, content) => count + (contentMatchesPrompt(content, prompt) ? 1 : 0),
    0,
  );
}

export function generationSignalBelongsToCurrentTurn(
  signalPresent: boolean,
  requireMatchingUserMessage: boolean,
  hasNewMatchingUserMessage: boolean,
): boolean {
  return signalPresent && (!requireMatchingUserMessage || hasNewMatchingUserMessage);
}
