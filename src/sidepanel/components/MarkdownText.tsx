import React, { type ReactNode } from 'react';

interface Props {
  text: string;
}

interface MarkdownTableMatch {
  header: string[];
  rows: string[][];
  nextCursor: number;
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}_])__[^_\n]+__(?![\p{L}\p{N}_])|\*[^*\n]+\*|(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])|\[[^\]\n]+\]\([^)\n]+\)|https?:\/\/[^\s<]+)/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(...renderBreaks(text.slice(cursor, match.index), `${keyPrefix}-plain-${index}`));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;

    if (token.startsWith('`')) {
      nodes.push(<code key={key} className="rounded-sm bg-slate-200 px-1 py-0.5 font-mono text-[0.9em] text-slate-900">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key} className="font-semibold text-slate-950">{renderInline(token.slice(2, -2), `${key}-strong`)}</strong>);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), `${key}-em`)}</em>);
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link ? safeUrl(link[2]) : null;
      nodes.push(href ? (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-900">
          {link?.[1]}
        </a>
      ) : <span key={key}>{token}</span>);
    } else {
      const href = safeUrl(token);
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-sky-700 underline decoration-sky-300 underline-offset-2">{token}</a> : token);
    }

    cursor = match.index + token.length;
    index += 1;
  }

  if (cursor < text.length) nodes.push(...renderBreaks(text.slice(cursor), `${keyPrefix}-tail`));
  return nodes;
}

function renderBreaks(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => index === 0 ? [line] : [<br key={`${keyPrefix}-br-${index}`} />, line]);
}

function startsBlock(line: string): boolean {
  return /^(#{1,6})\s+/.test(line) || /^\s*(```|~~~)/.test(line) || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line) || /^\s*>/.test(line) || /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function splitTableRow(line: string): string[] | null {
  let source = line.trim();
  if (!source.includes('|')) return null;
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|') && !isEscapedAt(source, source.length - 1)) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\' && source[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (source[index] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += source[index];
    }
  }
  cells.push(cell.trim());
  return cells.length >= 2 ? cells : null;
}

function matchTable(lines: readonly string[], cursor: number): MarkdownTableMatch | null {
  if (cursor + 1 >= lines.length) return null;
  const header = splitTableRow(lines[cursor]);
  const delimiter = splitTableRow(lines[cursor + 1]);
  if (!header || !delimiter || delimiter.length !== header.length) return null;
  if (!delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;

  const rows: string[][] = [];
  let nextCursor = cursor + 2;
  while (nextCursor < lines.length && lines[nextCursor].trim()) {
    const row = splitTableRow(lines[nextCursor]);
    if (!row) break;
    rows.push([...row, ...Array.from({ length: Math.max(0, header.length - row.length) }, () => '')].slice(0, header.length));
    nextCursor += 1;
  }
  return { header, rows, nextCursor };
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let cursor = 0;
  let blockIndex = 0;

  while (cursor < lines.length) {
    if (!lines[cursor].trim()) {
      cursor += 1;
      continue;
    }
    const key = `block-${blockIndex++}`;
    const fence = lines[cursor].match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2].trim();
      const code: string[] = [];
      cursor += 1;
      while (cursor < lines.length && !lines[cursor].trimStart().startsWith(marker)) code.push(lines[cursor++]);
      if (cursor < lines.length) cursor += 1;
      blocks.push(
        <div key={key} className="my-3 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-100">
          {language && <div className="border-b border-slate-800 px-3 py-1 text-[11px] uppercase tracking-wide text-slate-400">{language}</div>}
          <pre className="overflow-x-auto p-3 text-xs leading-relaxed"><code>{code.join('\n')}</code></pre>
        </div>,
      );
      continue;
    }

    const heading = lines[cursor].match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const classes = ['text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm', 'text-xs'][level - 1];
      blocks.push(React.createElement(`h${level}`, { key, className: `mb-2 mt-4 font-semibold text-slate-950 first:mt-0 ${classes}` }, renderInline(heading[2], `${key}-heading`)));
      cursor += 1;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[cursor])) {
      blocks.push(<hr key={key} className="my-4 border-slate-200" />);
      cursor += 1;
      continue;
    }

    const table = matchTable(lines, cursor);
    if (table) {
      blocks.push(
        <div key={key} className="my-3 overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="bg-slate-50 text-slate-900">
              <tr>
                {table.header.map((cell, index) => (
                  <th key={`${key}-head-${index}`} className="border-b border-slate-200 px-3 py-2 font-semibold">
                    {renderInline(cell, `${key}-head-${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`} className="border-b border-slate-100 last:border-b-0">
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-cell-${rowIndex}-${cellIndex}`} className="px-3 py-2 align-top">
                      {renderInline(cell, `${key}-cell-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      cursor = table.nextCursor;
      continue;
    }

    if (/^\s*>/.test(lines[cursor])) {
      const quote: string[] = [];
      while (cursor < lines.length && /^\s*>/.test(lines[cursor])) quote.push(lines[cursor++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key} className="my-3 border-l-4 border-sky-200 bg-sky-50 px-3 py-2 text-slate-700">{renderInline(quote.join('\n'), `${key}-quote`)}</blockquote>);
      continue;
    }

    const list = lines[cursor].match(/^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/);
    if (list) {
      const ordered = Boolean(list[1]);
      const items: string[] = [];
      const start = ordered ? Number(list[1]) : undefined;
      while (cursor < lines.length) {
        const item = lines[cursor].match(/^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/);
        if (!item || Boolean(item[1]) !== ordered) break;
        items.push(item[3]);
        cursor += 1;
      }
      const children = items.map((item, index) => <li key={`${key}-${index}`} className="pl-1">{renderInline(item, `${key}-${index}`)}</li>);
      blocks.push(ordered
        ? <ol key={key} start={start} className="my-3 list-decimal space-y-1 pl-6">{children}</ol>
        : <ul key={key} className="my-3 list-disc space-y-1 pl-6">{children}</ul>);
      continue;
    }

    const paragraph = [lines[cursor++]];
    while (cursor < lines.length && lines[cursor].trim() && !startsBlock(lines[cursor])) paragraph.push(lines[cursor++]);
    blocks.push(<p key={key} className="my-3 first:mt-0 last:mb-0">{renderInline(paragraph.join('\n'), `${key}-paragraph`)}</p>);
  }

  return blocks;
}

export default function MarkdownText({ text }: Props) {
  return <div className="min-w-0 break-words leading-relaxed">{renderBlocks(text)}</div>;
}
