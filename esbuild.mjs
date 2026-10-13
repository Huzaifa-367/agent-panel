import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
// `npm run package` ships minified code: smaller to load, faster to start.
const release = process.argv.includes('--release');

mkdirSync('dist', { recursive: true });
mkdirSync('dist-test', { recursive: true });
mkdirSync('dist/codicons', { recursive: true });

// Stylesheets live one per component group, in this order; the build joins them.
const STYLES = ['tokens', 'base', 'thread', 'steps', 'file-card', 'composer', 'plan', 'panel'];

function copyAssets() {
  mkdirSync(join('dist', 'icons'), { recursive: true });
  for (const f of ['chat-light.svg', 'chat-dark.svg']) copyFileSync(join('webview', 'icons', f), join('dist', 'icons', f));
  writeFileSync(
    'dist/webview.css',
    STYLES.map((name) => `/* ${name}.css */\n${readFileSync(join('webview', 'styles', `${name}.css`), 'utf8')}`).join('\n'),
  );
  const codiconDir = join('node_modules', '@vscode', 'codicons', 'dist');
  if (existsSync(codiconDir)) {
    copyFileSync(join(codiconDir, 'codicon.css'), join('dist', 'codicons', 'codicon.css'));
    copyFileSync(join(codiconDir, 'codicon.ttf'), join('dist', 'codicons', 'codicon.ttf'));
  }
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  sourcemap: !release,
  minify: release,
  logLevel: 'info',
};

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
};

const webview = {
  ...common,
  entryPoints: ['webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

const tests = {
  ...common,
  entryPoints: [
    'test/claude-parser.test.ts',
    'test/claude-args.test.ts',
    'test/cursor-parser.test.ts',
    'test/changes.test.ts',
    'test/diff-hunks.test.ts',
    'test/review-pipeline.test.ts',
    'test/models.test.ts',
    'test/markdown.test.ts',
    'test/shell-highlight.test.ts',
    'test/subagent.test.ts',
    'test/linediff.test.ts',
    'test/editdiff.test.ts',
    'test/handover.test.ts',
    'test/catalogs.test.ts',
  ],
  outdir: 'dist-test',
  format: 'cjs',
  external: ['vscode'],
};

async function run() {
  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(extension),
      esbuild.context(webview),
      esbuild.context(tests),
    ]);
    await Promise.all(contexts.map((c) => c.watch()));
    copyAssets();
    console.log('watching…');
    return;
  }

  await Promise.all([esbuild.build(extension), esbuild.build(webview), esbuild.build(tests)]);
  copyAssets();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
