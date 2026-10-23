import { readFileSync } from 'node:fs';
import { extractResponseContent } from '../../src/content/responseSerializer.ts';
import { isMetaResponseCandidate, metaResponseContentRoot, prepareMetaResponse } from '../../src/content/metaDom.ts';

interface CapturedNode {
  nodeType: number;
  tagName?: string;
  textContent?: string;
  innerText?: string;
  attrs?: Record<string, string>;
  childNodes?: CapturedNode[];
}

// Read-only DOM observations from the user's own check 1421, with SVG paths,
// scripts and styles omitted. No provider state, credentials or page scripts.
class FixtureNode {
  readonly nodeType: number;
  readonly tagName: string;
  readonly childNodes: FixtureNode[];
  readonly attrs: Record<string, string>;
  readonly innerText: string | undefined;
  readonly disabled = false;
  parentElement?: FixtureNode;
  private readonly rawText?: string;
  constructor(node: CapturedNode, parent?: FixtureNode) {
    this.nodeType = node.nodeType;
    this.tagName = node.tagName ?? '';
    this.attrs = node.attrs ?? {};
    this.innerText = node.innerText;
    this.rawText = node.textContent;
    this.parentElement = parent;
    this.childNodes = (node.childNodes ?? []).map(child => new FixtureNode(child, this));
  }
  get textContent(): string { return this.rawText ?? this.childNodes.map(child => child.textContent).join(''); }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const candidate = part.trim();
      if (candidate.startsWith('.')) return (this.attrs.class ?? '').split(/\s+/).includes(candidate.slice(1));
      const attribute = candidate.match(/^\[([\w-]+)(?:(\*?=)"([^"]*)")?\]$/);
      if (attribute) {
        const value = this.getAttribute(attribute[1]);
        return value !== null && (!attribute[2] || (attribute[2] === '*=' ? value.includes(attribute[3]) : value === attribute[3]));
      }
      if (candidate === 'button[aria-label]') return this.tagName === 'BUTTON' && this.getAttribute('aria-label') !== null;
      return candidate.toUpperCase() === this.tagName;
    });
  }
  contains(other: FixtureNode): boolean { return this === other || this.childNodes.some(child => child.contains(other)); }
  closest(selector: string): FixtureNode | null {
    for (let node: FixtureNode | undefined = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): FixtureNode[] {
    return this.childNodes.flatMap(child => [
      ...(child.nodeType === 1 && child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): FixtureNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  click(): never { throw new Error('Captured expanded response must require no actions'); }
}

export function capturedMetaResponse(): string {
  const captured = JSON.parse(readFileSync(new URL('../fixtures/meta-coding-1421.json', import.meta.url), 'utf8')) as CapturedNode;
  const response = new FixtureNode(captured) as unknown as Element;
  if (!isMetaResponseCandidate(response) || !prepareMetaResponse(response)) throw new Error('Captured answer is not ready');
  const text = extractResponseContent(response, metaResponseContentRoot);
  if (!text) throw new Error('Captured answer was empty');
  return text;
}
