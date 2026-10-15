import { focusWithoutScroll } from './focusWithoutScroll';
import { isUsableGeminiComposerInput, isVisibleGeminiElement } from './geminiDom';

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
// A controlled Gemini editor may reconcile after more than one background-tab
// timer quantum. Keep the one native edit and exact readback contract, but do
// not turn a delayed commit into the same failure as a changed prompt.
const INSERT_SETTLEMENT_TIMEOUT_MS = 8000;
const INSERT_SETTLEMENT_POLL_MS = 25;

export async function injectGeminiInput(
  input: Element,
  text: string,
  isActive: () => boolean = () => true,
): Promise<void> {
  assertCurrentEditor(input, isActive);
  if (geminiComposerMatches(input, text)) return;
  assertNoDifferentDraft(input);
  const editor = input as HTMLElement;
  focusWithoutScroll(editor);

  // Let a controlled editor settle its focus before refreshing the selection that
  // will receive the one browser-native text edit.
  await nextTask();
  assertCurrentEditor(input, isActive);
  if (geminiComposerMatches(input, text)) return;
  assertNoDifferentDraft(input);
  assertEditorFocused(editor);
  selectEditorContents(editor);
  assertEditorFocused(editor);
  try {
    if (typeof document.execCommand !== 'function') throw new Error('insertText unavailable');
    // Do not retry with a synthetic paste, keyboard event or direct DOM mutation:
    // one native edit plus exact readback prevents ambiguous duplicate submissions.
    document.execCommand('insertText', false, text);
  } catch {
    throw new Error('native text insertion failed');
  }

  // Reconciliation may take several tasks. Wait only by reading the live editor;
  // never patch visible DOM or replay a failed insertion with another edit.
  await nextTask();
  const deadline = Date.now() + INSERT_SETTLEMENT_TIMEOUT_MS;
  while (true) {
    assertCurrentEditor(input, isActive);
    if (geminiComposerMatches(input, text)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('editor text did not match the requested prompt');
    await new Promise(resolve => setTimeout(resolve, Math.min(INSERT_SETTLEMENT_POLL_MS, remaining)));
  }
}

export function readGeminiComposerText(input: Element): string {
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) return input.value;
  const nodes = Array.from(input.childNodes ?? []);
  if (!nodes.length) return input.textContent ?? '';
  const blocks = nodes.filter((node): node is Element => node.nodeType === 1);
  if (blocks.length === nodes.length && blocks.every(block => BLOCK_TAGS.has(block.tagName))) {
    return blocks.map(block => {
      const text = readInline(block);
      // A lone BR is the editor's empty-paragraph placeholder, not another line.
      return text === '\n' ? '' : text;
    }).join('\n');
  }
  return readInline(input);
}

export function geminiComposerMatches(input: Element, expected: string): boolean {
  const normalizeLineEndings = (value: string) => value.replace(/\r\n?/g, '\n');
  return normalizeLineEndings(readGeminiComposerText(input)) === normalizeLineEndings(expected);
}

function readInline(element: Element): string {
  let text = '';
  for (const child of Array.from(element.childNodes ?? [])) {
    if (child.nodeType === 3) text += child.textContent ?? '';
    else if (child.nodeType === 1) {
      const nested = child as Element;
      text += nested.tagName === 'BR' ? '\n' : readInline(nested);
    }
  }
  return text;
}

function assertNoDifferentDraft(input: Element): void {
  // Whitespace can be meaningful user input. `readGeminiComposerText` already
  // normalizes only the editor's lone <p><br></p> placeholder to an empty value.
  if (readGeminiComposerText(input)) throw new Error('live editor contains a different draft');
}

function assertEditorFocused(editor: HTMLElement): void {
  const active = document.activeElement;
  if (active !== editor && !editor.contains(active)) {
    throw new Error('editor focus moved before insertion');
  }
}

function selectEditorContents(editor: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) throw new Error('editor selection unavailable before insertion');
  try {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    throw new Error('editor selection unavailable before insertion');
  }
  if (selection.rangeCount !== 1) throw new Error('editor selection unavailable before insertion');
  let selectedContainer: Node;
  try {
    selectedContainer = selection.getRangeAt(0).commonAncestorContainer;
  } catch {
    throw new Error('editor selection unavailable before insertion');
  }
  if (selectedContainer !== editor && !editor.contains(selectedContainer)) {
    throw new Error('editor selection moved before insertion');
  }
}

function assertCurrentEditor(input: Element, isActive: () => boolean): void {
  if (!isActive()) throw new Error('request cancelled during input injection');
  if (input.isConnected === false) throw new Error('editor disconnected during input injection');
  if (!isUsableGeminiComposerInput(input as HTMLElement) || !isVisibleGeminiElement(input)) {
    throw new Error('editor unavailable during input injection');
  }
}

function nextTask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
