/**
 * Light syntax colouring for diffs and code blocks, one line at a time. Webviews can't
 * read the editor's token colours, so the classes map to the theme's own colour
 * variables (see `--ap-syn-*` in tokens.css): it follows any theme, dark or light.
 */

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue default def defer delete do elif else enum export extends ' +
    'false final finally fn for foreach from func function get go if impl implements import in instanceof interface is let ' +
    'match mod module mut namespace new nil none not null of or and package private protected pub public readonly return ' +
    'self set static struct super switch this throw throws trait true try type typeof undefined unless use using var void ' +
    'where while with yield echo require include include_once require_once endif endforeach fn lambda pass raise except ' +
    'True False None select from where join on group order by insert update delete create table values into'
  ).split(' '),
);

const LANG_ALIASES: Record<string, string> = {
  ts: 'c', tsx: 'c', js: 'c', jsx: 'c', mjs: 'c', cjs: 'c', json: 'c', java: 'c', go: 'c', rs: 'c', c: 'c', cpp: 'c', cs: 'c',
  php: 'c', swift: 'c', kt: 'c', dart: 'c', css: 'c', scss: 'c', vue: 'c',
  py: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash', env: 'hash',
  sql: 'sql', md: 'none', txt: 'none', text: 'none', diff: 'none',
  html: 'markup', xml: 'markup', svg: 'markup',
};

export function langFromPath(path: string): string {
  const m = /\.(blade\.php|[a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase().replace('blade.php', 'php') : '';
}

function family(lang: string): string {
  return LANG_ALIASES[lang.toLowerCase()] ?? (lang ? 'c' : 'none');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const span = (cls: string, s: string) => `<span class="ap-syn-${cls}">${esc(s)}</span>`;

/** One line of code to HTML with `ap-syn-*` spans. Long lines are left plain. */
export function highlightLine(line: string, lang: string): string {
  const fam = family(lang);
  if (fam === 'none' || line.length > 2000) return esc(line);
  const comment = fam === 'hash' ? /^#.*/ : fam === 'sql' ? /^--.*/ : fam === 'markup' ? /^<!--.*?(-->|$)/ : /^(\/\/.*|\/\*.*?(\*\/|$))/;
  let out = '';
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    let m: RegExpExecArray | null;
    if ((m = comment.exec(rest))) {
      out += span('comment', m[0]);
      i += m[0].length;
    } else if ((m = /^("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/.exec(rest))) {
      out += span('string', m[0]);
      i += m[0].length;
    } else if ((m = /^\b(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)\b/i.exec(rest))) {
      out += span('number', m[0]);
      i += m[0].length;
    } else if (fam === 'markup' && (m = /^<\/?[A-Za-z][\w:.-]*/.exec(rest))) {
      out += esc(m[0].slice(0, m[0].startsWith('</') ? 2 : 1)) + span('type', m[0].replace(/^<\/?/, ''));
      i += m[0].length;
    } else if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
      const w = m[0];
      const next = line.slice(i + w.length);
      if (KEYWORDS.has(w)) out += span('keyword', w);
      else if (/^\s*\(/.test(next)) out += span('func', w);
      else if (/^[A-Z]/.test(w) && w.length > 1) out += span('type', w);
      else if (w.startsWith('$')) out += span('var', w);
      else out += esc(w);
      i += w.length;
    } else if (fam === 'c' && (m = /^<\/?[A-Z][\w.]*/.exec(rest))) {
      // JSX components
      out += esc(m[0].slice(0, m[0].startsWith('</') ? 2 : 1)) + span('type', m[0].replace(/^<\/?/, ''));
      i += m[0].length;
    } else {
      out += esc(rest[0]);
      i += 1;
    }
  }
  return out;
}

export function highlightBlock(code: string, lang: string): string {
  return code
    .split('\n')
    .map((l) => highlightLine(l, lang))
    .join('\n');
}

/** A shell command to HTML: commands, flags, strings, variables and operators in colour. */
export function highlightShell(command: string): string {
  const lines = command.split('\n');
  let heredoc: { end: string; lang: string } | undefined;
  return lines
    .map((line) => {
      if (heredoc) {
        if (line.trim() === heredoc.end) {
          heredoc = undefined;
          return span('keyword', line);
        }
        return highlightLine(line, heredoc.lang);
      }
      const here = /<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/.exec(line);
      if (here) {
        // The body is usually code for the file named in the redirect.
        const file = /(?:>>?|tee(?:\s+-a)?)\s+([^\s<]+)/.exec(line)?.[1] ?? '';
        heredoc = { end: here[1], lang: langFromPath(file) || 'ts' };
      }
      return shellLine(line);
    })
    .join('\n');
}

function shellLine(line: string): string {
  let out = '';
  let i = 0;
  let atCommand = true;
  while (i < line.length) {
    const rest = line.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^#.*/.exec(rest)) && (i === 0 || /\s/.test(line[i - 1]))) {
      out += span('comment', m[0]);
      i += m[0].length;
    } else if ((m = /^("(?:[^"\\]|\\.)*"?|'[^']*'?)/.exec(rest))) {
      out += span('string', m[0]);
      i += m[0].length;
      atCommand = false;
    } else if ((m = /^(&&|\|\||\||;|&(?!>)|>>?|<<-?|<|2>&1|2>|&>)/.exec(rest))) {
      out += span('keyword', m[0]);
      i += m[0].length;
      atCommand = /^(&&|\|\||\||;|&)$/.test(m[0]);
    } else if ((m = /^\$\{?[A-Za-z_][\w]*\}?|^\$\(|^\$[?#@*0-9]/.exec(rest))) {
      out += span('var', m[0]);
      i += m[0].length;
    } else if ((m = /^--?[A-Za-z][\w-]*(=[^\s"']*)?/.exec(rest)) && (i === 0 || /[\s(]/.test(line[i - 1]))) {
      out += span('type', m[0]);
      i += m[0].length;
    } else if ((m = /^\d+(\.\d+)?\b/.exec(rest))) {
      out += span('number', m[0]);
      i += m[0].length;
    } else if ((m = /^[^\s|&;<>"'$#()]+/.exec(rest))) {
      const w = m[0];
      if (atCommand && /^\w[\w./-]*$/.test(w) && !/^[A-Za-z_]\w*=/.test(w)) {
        out += span(/^(cd|export|source|if|then|else|fi|for|do|done|while|case|esac|in)$/.test(w) ? 'keyword' : 'func', w);
        atCommand = false;
      } else if (/^[A-Za-z_]\w*=/.test(w)) {
        const eq = w.indexOf('=');
        out += span('var', w.slice(0, eq)) + esc(w.slice(eq));
      } else if (/^(\.{0,2}\/|~\/)|\.[A-Za-z0-9]{1,5}$/.test(w)) {
        out += `<span class="ap-syn-path">${esc(w)}</span>`;
        atCommand = false;
      } else {
        out += esc(w);
        atCommand = false;
      }
      i += w.length;
    } else {
      out += esc(rest[0]);
      i += 1;
    }
  }
  return out;
}

const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/**
 * Command output to HTML. Terminal colour codes become the theme's terminal colours; output
 * with none gets a light tint on lines that read as success, warnings or errors.
 */
export function highlightOutput(text: string): string {
  if (/\u001b\[[\d;]*m/.test(text)) return ansiHtml(text);
  return text
    .split('\n')
    .map((l) => {
      const e = esc(l);
      if (/^\s*(error|err!|fatal|failed|✗|✖|×|FAIL\b)|\b(Error|Exception|ERROR|FAILED)\b/.test(l)) return `<span class="ap-out-error">${e}</span>`;
      if (/^\s*(warn(ing)?|deprecat)|\b(WARN|warning)\b/i.test(l)) return `<span class="ap-out-warn">${e}</span>`;
      if (/^\s*(✓|✔|ok\b|pass\b|PASS\b|success|done\b|built in)|\b(passed|succeeded)\b/i.test(l)) return `<span class="ap-out-ok">${e}</span>`;
      return e;
    })
    .join('\n');
}

export function ansiHtml(text: string): string {
  let out = '';
  let open = '';
  let last = 0;
  const re = /\u001b\[([\d;]*)m/g;
  const flush = (to: number) => {
    const chunk = text.slice(last, to).replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
    if (chunk) out += open ? `<span class="${open}">${esc(chunk)}</span>` : esc(chunk);
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    flush(m.index);
    last = m.index + m[0].length;
    const classes: string[] = [];
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) classes.length = 0;
      else if (code === 1) classes.push('ap-ansi-bold');
      else if (code === 2) classes.push('ap-ansi-dim');
      else if (code >= 30 && code <= 37) classes.push(`ap-ansi-${ANSI_COLORS[code - 30]}`);
      else if (code >= 90 && code <= 97) classes.push(`ap-ansi-${ANSI_COLORS[code - 90]}`);
    }
    open = classes.join(' ');
  }
  flush(text.length);
  return out;
}
