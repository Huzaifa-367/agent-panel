import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * What `/` offers for Claude, grouped like Cursor's menu: skills, then commands, each
 * with its description. Read from the skill and command files Claude Code itself loads
 * (user and project), plus the built-in commands the CLI reports.
 */

export interface SlashItem {
  name: string;
  description: string;
  kind: 'skill' | 'command';
  /** The SKILL.md or command file, for engines that need it expanded. */
  path?: string;
}

const BUILTIN: Record<string, string> = {
  compact: 'Summarize the conversation to free up context',
  clear: 'Start the conversation fresh',
  context: 'Show what fills the context window',
  cost: 'Show the cost of this session',
  init: 'Write a CLAUDE.md for this project',
  review: 'Review a pull request',
  'security-review': 'Review the pending changes for security issues',
  memory: 'Edit memory files',
  model: 'Switch the model',
  agents: 'Manage subagents',
  mcp: 'Manage MCP servers',
  hooks: 'Manage hooks',
  permissions: 'Manage permissions',
  status: 'Show account and session status',
  usage: 'Show plan usage',
};

function frontmatter(file: string): Record<string, string> {
  try {
    const text = readFileSync(file, 'utf8').slice(0, 4000);
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    const out: Record<string, string> = {};
    if (m) {
      for (const line of m[1].split('\n')) {
        const kv = /^([\w-]+):\s*(.*)$/.exec(line);
        if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
      }
    }
    if (!out.description) {
      const body = (m ? text.slice(m[0].length) : text).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (body) out.description = body;
    }
    return out;
  } catch {
    return {};
  }
}

function skillsIn(dir: string): SlashItem[] {
  try {
    return readdirSync(dir)
      .filter((d) => existsSync(join(dir, d, 'SKILL.md')))
      .map((d) => {
        const fm = frontmatter(join(dir, d, 'SKILL.md'));
        return { name: fm.name || d, description: fm.description ?? '', kind: 'skill' as const, path: join(dir, d, 'SKILL.md') };
      });
  } catch {
    return []; // missing folder, or a path that isn't one
  }
}

function commandsIn(dir: string, prefix = ''): SlashItem[] {
  const out: SlashItem[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of names) {
    const p = join(dir, f);
    try {
      if (statSync(p).isDirectory()) out.push(...commandsIn(p, `${prefix}${f}:`));
      else if (f.endsWith('.md')) out.push({ name: `${prefix}${f.slice(0, -3)}`, description: frontmatter(p).description ?? '', kind: 'command', path: p });
    } catch {
      /* a dangling symlink or unreadable file: skip just that entry */
    }
  }
  return out;
}

/** Skills and commands for this workspace; `reported` are the names the CLI announced. */
export function slashItems(root: string | undefined, reported: string[]): SlashItem[] {
  const home = join(homedir(), '.claude');
  const skills = [...(root ? skillsIn(join(root, '.claude', 'skills')) : []), ...skillsIn(join(home, 'skills'))];
  const commands = [...(root ? commandsIn(join(root, '.claude', 'commands')) : []), ...commandsIn(join(home, 'commands'))];
  const seen = new Set<string>();
  const out: SlashItem[] = [];
  for (const item of [...skills, ...commands]) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push({ ...item, description: item.description.length > 160 ? `${item.description.slice(0, 157)}…` : item.description });
  }
  // Built-ins and plugin commands the CLI reported but no file describes.
  for (const name of reported) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: BUILTIN[name] ?? '', kind: /:/.test(name) || !BUILTIN[name] ? 'skill' : 'command' });
  }
  for (const [name, description] of Object.entries(BUILTIN)) {
    if (!seen.has(name)) out.push({ name, description, kind: 'command' });
  }
  return out;
}


/** Cursor's skills and commands: user, built-in, project and plugin ones, like Cursor's own `/` menu. */
export function cursorSlashItems(root: string | undefined): SlashItem[] {
  const home = join(homedir(), '.cursor');
  const plugins: SlashItem[] = [];
  const cache = join(home, 'plugins', 'cache');
  if (existsSync(cache)) {
    // plugins/cache/<source>/<plugin>/<version>/{skills,commands}
    for (const src of readdirSync(cache)) {
      for (const plugin of safeDirs(join(cache, src))) {
        for (const ver of safeDirs(join(cache, src, plugin))) {
          const base = join(cache, src, plugin, ver);
          plugins.push(...skillsIn(join(base, 'skills')), ...commandsIn(join(base, 'commands')));
        }
      }
    }
  }
  const all = [
    ...(root ? [...skillsIn(join(root, '.cursor', 'skills')), ...commandsIn(join(root, '.cursor', 'commands'))] : []),
    ...skillsIn(join(home, 'skills')),
    ...commandsIn(join(home, 'commands')),
    ...skillsIn(join(home, 'skills-cursor')),
    ...plugins,
  ];
  const seen = new Set<string>();
  return all.filter((i) => (seen.has(i.name) ? false : (seen.add(i.name), true))).map((i) => ({ ...i, description: i.description.length > 160 ? `${i.description.slice(0, 157)}…` : i.description }));
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory());
  } catch {
    return [];
  }
}

/**
 * Cursor's CLI takes a plain prompt, so `/name args` is expanded here: a command becomes
 * its prompt text (with the arguments filled in), a skill becomes "read and follow it".
 */
export function expandForCursor(prompt: string, items: SlashItem[]): string {
  const m = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(prompt.trim());
  if (!m) return prompt;
  const item = items.find((i) => i.name === m[1]);
  if (!item?.path) return prompt;
  const args = m[2].trim();
  if (item.kind === 'skill') {
    return `Use the "${item.name}" skill: read ${item.path} and follow it.${args ? `\n\n${args}` : ''}`;
  }
  try {
    const body = readFileSync(item.path, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    return body.includes('$ARGUMENTS') ? body.replace(/\$ARGUMENTS/g, args) : `${body}${args ? `\n\n${args}` : ''}`;
  } catch {
    return prompt;
  }
}
