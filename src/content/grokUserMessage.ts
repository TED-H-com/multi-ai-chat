import { serializeResponseText } from './responseSerializer';
import { grokResponseContentRoot } from './grokDom';

export function readGrokUserMessageText(message: Element): string {
  // Rendered user bubbles lose list markers in innerText. Restore the Markdown
  // structure so a SPA remount can reacquire the accepted user turn.
  return serializeResponseText(grokResponseContentRoot(message), {
    preserveTextWhitespace: true,
    codeBlockSelectors: ['[data-testid="code-block"]'],
  });
}
