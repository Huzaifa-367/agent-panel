import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ansiHtml, highlightOutput, highlightShell } from '../webview/highlight';

describe('highlightShell', () => {
  it('colours commands, flags, strings, variables and operators', () => {
    const html = highlightShell('cd src && grep -n "a<b" $HOME/x.ts | head -5 # note');
    assert.match(html, /<span class="ap-syn-keyword">cd<\/span>/);
    assert.match(html, /<span class="ap-syn-func">grep<\/span>/);
    assert.match(html, /<span class="ap-syn-type">-n<\/span>/);
    assert.match(html, /<span class="ap-syn-string">&quot;a&lt;b&quot;<\/span>/);
    assert.match(html, /<span class="ap-syn-var">\$HOME<\/span>/);
    assert.match(html, /<span class="ap-syn-func">head<\/span>/);
    assert.match(html, /<span class="ap-syn-comment"># note<\/span>/);
  });

  it('highlights a heredoc body as the redirected file\'s language', () => {
    const html = highlightShell("cat >> test/a.test.ts <<'EOF'\nconst x = 1;\nEOF\nnpm test");
    assert.match(html, /<span class="ap-syn-keyword">const<\/span> x = <span class="ap-syn-number">1<\/span>/);
    assert.match(html, /<span class="ap-syn-func">npm<\/span>/);
  });

  it('escapes markup in the command', () => {
    assert.ok(!highlightShell('echo <script>').includes('<script>'));
  });
});

describe('highlightOutput', () => {
  it('turns terminal colour codes into theme classes and drops other codes', () => {
    assert.equal(ansiHtml('\u001b[32mok\u001b[0m done\u001b[2K'), '<span class="ap-ansi-green">ok</span> done');
  });

  it('tints success, warning and error lines when there are no codes', () => {
    const html = highlightOutput('✓ built in 6s\nwarning: slow\nError: boom\nplain');
    assert.match(html, /ap-out-ok">✓ built in 6s/);
    assert.match(html, /ap-out-warn">warning: slow/);
    assert.match(html, /ap-out-error">Error: boom/);
    assert.match(html, /\nplain$/);
  });
});
