import { createContentScript } from './base';

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden'
    && !(style.opacity !== '' && Number(style.opacity) === 0)
    && element.getClientRects().length > 0;
}

function isUsableClaudeComposer(element: Element): boolean {
  const editable = element.getAttribute('contenteditable') === 'true'
    || (element as HTMLElement).isContentEditable;
  if (!editable || !isVisible(element)) return false;
  if ((element as HTMLInputElement).disabled || element.getAttribute('aria-disabled') === 'true') return false;
  if (element.closest('[inert], [aria-hidden="true"]')) return false;
  // Claude's supported composer is ProseMirror. The fieldset fallback covers
  // the normal composer wrapper without accepting an arbitrary page editor.
  return element.matches('.ProseMirror[contenteditable="true"], [contenteditable="true"].ProseMirror')
    || Boolean(element.closest('fieldset'));
}

function isClaudeSendControl(element: Element): boolean {
  if (!element.matches('button') || !isVisible(element)) return false;
  if ((element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true') return false;
  const label = element.getAttribute('aria-label') ?? '';
  return label === 'Send Message' || label === 'Send message' || label === 'Send'
    || Boolean(element.closest('fieldset'));
}

createContentScript({
  provider: 'claude',

  inputSelectors: [
    // ProseMirror editor used by Claude
    '.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"].ProseMirror',
    'div.ProseMirror',
    // Fallback
    'fieldset div[contenteditable="true"]',
  ],
  requireVisibleInput: true,
  inputFilter: isUsableClaudeComposer,
  preserveExistingDraft: true,

  sendButtonSelectors: [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]',
    // The send button is often the last button in the input area
    'fieldset button[type="button"]:last-of-type',
  ],
  sendButtonFilter: isClaudeSendControl,

  responseSelectors: [
    // Claude response containers (actual class: font-claude-response)
    '.font-claude-response',
    '[data-is-streaming] .font-claude-response',
    // Fallback
    '.font-claude-message',
  ],

  stopButtonSelectors: [
    'button[aria-label="Stop Response"]',
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop"]',
    'button[aria-label="停止回應"]',
    'button[aria-label="停止"]',
  ],

  loginDetector: () => {
    // Missing markup can mean loading, navigation or usage gating, not logout.
    return (
      document.querySelector('.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"].ProseMirror')
    ) ? true : null;
  },

  // Detect if Claude is still generating (streaming indicator or stop button)
  isThinking: () => {
    // data-is-streaming="true" on response container (NOT just [data-is-streaming] — "false" also matches)
    if (document.querySelector('[data-is-streaming="true"]')) return true;
    // Stop button visible during generation
    if (document.querySelector('button[aria-label="Stop Response"]')) return true;
    if (document.querySelector('button[aria-label="Stop response"]')) return true;
    if (document.querySelector('button[aria-label="Stop"]')) return true;
    // 中文介面的 aria-label 不是英文，少了這兩行等於整個串流偵測只剩 data-is-streaming
    if (document.querySelector('button[aria-label="停止回應"]')) return true;
    if (document.querySelector('button[aria-label="停止"]')) return true;
    return false;
  },

  // Custom input for ProseMirror — it needs special handling
  injectInput: async (el: Element, text: string) => {
    const editor = el as HTMLElement;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    await Promise.resolve();

    if (!matches(editor.textContent ?? '', text)) {
      editor.focus();
      range.selectNodeContents(editor);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      await Promise.resolve();
    }

    if (!matches(editor.textContent ?? '', text)) {
      editor.replaceChildren();
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      editor.appendChild(paragraph);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  },

  doneDelay: 5000,
  chunkDebounce: 500,
});

function matches(actual: string, expected: string): boolean {
  return actual.replace(/\s+/g, '') === expected.replace(/\s+/g, '');
}
