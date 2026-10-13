import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../webview/markdown';

describe('markdown', () => {
  it('joins lines into one paragraph and splits on blank lines', () => {
    assert.equal(renderMarkdown('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
  });

  it('leaves code spans alone', () => {
    assert.equal(renderMarkdown('use `**not bold**` here'), '<p>use <code>**not bold**</code> here</p>');
  });

  it('escapes html', () => {
    assert.equal(renderMarkdown('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('drops javascript links', () => {
    assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>x</p>');
  });

  it('nests lists', () => {
    const html = renderMarkdown('- a\n  - b\n- c');
    assert.equal(html, '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  });

  it('renders fenced code with a copy button', () => {
    const html = renderMarkdown('```ts\nconst a = 1 < 2;\n```');
    assert.match(html, /class="ap-codeblock"/);
    assert.match(html, /<span class="ap-syn-keyword">const<\/span> a = <span class="ap-syn-number">1<\/span> &lt; <span class="ap-syn-number">2<\/span>;/);
    assert.match(html, /data-copy=/);
  });

  it('renders tables, quotes and rules', () => {
    assert.match(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |'), /<thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr>/);
    assert.match(renderMarkdown('> note'), /<blockquote><p>note<\/p><\/blockquote>/);
    assert.equal(renderMarkdown('---'), '<hr>');
  });

  it('keeps underscores inside a link target intact', () => {
    const html = renderMarkdown('see [docs](https://example.com/a__b__c) and https://example.com/_x_/y');
    assert.ok(html.includes('href="https://example.com/a__b__c"'));
    assert.ok(html.includes('href="https://example.com/_x_/y"'));
    assert.ok(!html.includes('<strong>b</strong>'));
  });
});
