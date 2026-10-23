/** Read visual paragraph boundaries rather than concatenating rich-editor blocks. */
export function readComposerText(input: Element): string {
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return (input as HTMLTextAreaElement).value;
  const editor = input as HTMLElement;
  return editor.innerText || editor.textContent || '';
}

export function composerMatchesPrompt(input: Element, expected: string): boolean {
  return normalizeComposerText(readComposerText(input)) === normalizeComposerText(expected);
}

// Rich editors add layout breaks between paragraphs. Collapse only formatting
// line breaks: preserve horizontal whitespace, word boundaries and quoted source.
function normalizeComposerText(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  const literals = /"(?:\\.|[^"\\])*"|(?<![\p{L}\p{N}_])'(?:\\.|[^'\\])*'(?![\p{L}\p{N}_])/gu;
  let result = '';
  let end = 0;
  for (const match of normalized.matchAll(literals)) {
    result += normalized.slice(end, match.index).replace(/\n+/g, '\n') + match[0];
    end = match.index + match[0].length;
  }
  return (result + normalized.slice(end).replace(/\n+/g, '\n')).trim();
}
