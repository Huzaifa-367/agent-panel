import { highlightBlock } from './highlight';

/** Small markdown renderer for answers: `.ap-md` markup, code blocks as `.ap-codeblock`. */

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let table: string[][] = [];
  /** Open lists, innermost last, with the indent each was opened at. */
  const lists: { type: 'ul' | 'ol'; indent: number }[] = [];
  let i = 0;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
    quote = [];
  };
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) {
      out.push(`</li></${lists.pop()!.type}>`);
    }
  };
  const flushTable = () => {
    if (!table.length) return;
    const [head, ...rest] = table;
    const body = rest[0] && rest[0].every((c) => /^\s*:?-{2,}:?\s*$/.test(c)) ? rest.slice(1) : rest;
    out.push(
      `<table><thead><tr>${head.map((c) => `<th>${inline(c.trim())}</th>`).join('')}</tr></thead><tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`,
    );
    table = [];
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushTable();
    closeLists();
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flushAll();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
        code.push(lines[i]);
        i += 1;
      }
      out.push(renderCode(code.join('\n'), fence[2]));
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      closeLists();
      flushTable();
      quote.push(line.replace(/^\s*>\s?/, ''));
      i += 1;
      continue;
    }
    flushQuote();

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      closeLists();
      table.push(line.trim().slice(1, -1).split('|'));
      i += 1;
      continue;
    }
    flushTable();

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(Math.max(heading[1].length, 3), 4);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      i += 1;
      continue;
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, '  ').length;
      const type = /\d/.test(item[2]) ? 'ol' : 'ul';
      const top = lists[lists.length - 1];
      if (!top || indent > top.indent) {
        const start = type === 'ol' ? Number.parseInt(item[2], 10) : 1;
        out.push(`<${type}${type === 'ol' && start !== 1 ? ` start="${start}"` : ''}><li>`);
        lists.push({ type, indent });
      } else {
        closeLists(indent);
        const cur = lists[lists.length - 1];
        if (cur && cur.type !== type && cur.indent === indent) {
          out.push(`</li></${lists.pop()!.type}><${type}><li>`);
          lists.push({ type, indent });
        } else if (cur) {
          out.push('</li><li>');
        } else {
          out.push(`<${type}><li>`);
          lists.push({ type, indent });
        }
      }
      out.push(inline(item[3]));
      i += 1;
      continue;
    }

    if (!line.trim()) {
      flushPara();
      // A blank line inside a list keeps the list open only if the next line continues it.
      const next = lines[i + 1] ?? '';
      if (lists.length && !/^(\s*)([-*+]|\d+[.)])\s+/.test(next) && !/^\s{2,}\S/.test(next)) closeLists();
      i += 1;
      continue;
    }

    if (lists.length && /^\s{2,}\S/.test(line)) {
      // Continuation of a list item.
      out.push(` ${inline(line.trim())}`);
      i += 1;
      continue;
    }

    closeLists();
    para.push(line);
    i += 1;
  }
  flushAll();
  return out.join('');
}

function renderCode(code: string, lang: string): string {
  const id = `c${Math.random().toString(36).slice(2, 9)}`;
  return `<div class="ap-codeblock"><div class="ap-codeblock__head"><span>${escapeHtml(lang || 'text')}</span><span class="ap-spacer"></span><button type="button" class="ap-icon-btn" title="Copy" aria-label="Copy" data-copy="${id}"><i class="codicon codicon-copy"></i></button></div><pre id="${id}"><code>${highlightBlock(code, lang)}</code></pre></div>`;
}

/** Inline markdown. Code spans are cut out first so nothing inside them is formatted. */
function inline(text: string): string {
  const codes: string[] = [];
  // URLs are swapped for placeholders so the emphasis rules below can't rewrite `a__b__c` inside an href.
  const urls: string[] = [];
  const link = (u: string) => `\u0001${urls.push(u) - 1}\u0001`;
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    // Inline code that names a file (with a folder or a known extension) opens it.
    const isPath = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[a-z0-9]{1,8}(?::\d+(?::\d+)?)?$/i.test(c) && /\/|\.(ts|tsx|js|jsx|php|py|css|md|json|ya?ml|go|rs|java|rb|vue|html|sh|sql|blade\.php)(:|$)/i.test(c);
    codes.push(isPath ? `<code class="ap-path" data-path="${escapeHtml(c)}" title="Open ${escapeHtml(c)}">${escapeHtml(c)}</code>` : `<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, label: string, href: string) => {
    const safe = /^(https:\/\/|http:\/\/|\.{0,2}\/|[\w-]+\/|[\w-]+\.[a-z]+)/i.test(href) && !/^javascript:/i.test(href);
    return safe ? `<a href="${link(href)}" title="${link(href)}">${label}</a>` : label;
  });
  s = s.replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => `${pre}<a href="${link(url)}" title="${link(url)}">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, n: string) => urls[Number(n)]).replace(/\u0000(\d+)\u0000/g, (_, n: string) => codes[Number(n)]);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
