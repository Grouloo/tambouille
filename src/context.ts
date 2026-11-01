// What a task sees: helpers to prepare its folder, then to check it. After the
// agent has run, the folder is untrusted: nothing there runs on the host, its Git
// included (a hook or a config would), and links do not lead out of it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { shell } from './sandbox.ts';
import type { Dirs, SandboxAccess } from './sandbox.ts';

const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export type TaskContext = ReturnType<typeof taskContext>;

export function taskContext({ dirs, numCtx, sandbox = {}, phase = 'setup' }: { dirs: Dirs; numCtx: number; sandbox?: SandboxAccess; phase?: 'setup' | 'check' }) {
  const inside = async (root: string, rel: string) => {
    const abs = path.resolve(root, rel);
    const real = await fs.realpath(abs).catch(() => null);
    return real && (real === dirs.root || real.startsWith(`${dirs.root}${path.sep}`)) ? real : null;
  };
  const hostGit = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dirs.home, GIT_CONFIG_GLOBAL: `${dirs.home}/.gitconfig`, GIT_EDITOR: 'true' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const git = async (cwd: string, args: string[]) => {
    if (phase === 'setup') return hostGit(cwd, args);
    const r = await shell(`cd ${q(cwd)} && git ${args.map(q).join(' ')}`, { dirs, ...sandbox });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const ctx = {
    numCtx,
    home: dirs.home,
    work: dirs.work,
    write: async (rel: string, content: string) => {
      const abs = path.join(dirs.work, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },
    remove: (rel: string) => fs.rm(path.join(dirs.work, rel), { recursive: true, force: true }),
    /** The text of a file of the project; null if missing, or if it leads out of the sandbox. */
    file: async (rel: string): Promise<string | null> => {
      const real = await inside(dirs.work, rel);
      return real ? fs.readFile(real, 'utf8').catch(() => null) : null;
    },
    homeFile: async (rel: string): Promise<string | null> => {
      const real = await inside(dirs.home, rel);
      return real ? fs.readFile(real, 'utf8').catch(() => null) : null;
    },
    git: (...args: string[]) => git(dirs.work, args),
    gitOut: (...args: string[]) => git(dirs.work, args),
    gitIn: (cwd: string, ...args: string[]) => git(cwd, args),
    gitInOut: (cwd: string, ...args: string[]) => git(cwd, args),
    hidden: async (name: string, body: string) => {
      await fs.mkdir(path.join(dirs.work, '.hidden'), { recursive: true });
      await fs.writeFile(path.join(dirs.work, '.hidden', name), body);
    },
    sh: (command: string) => shell(command, { dirs, ...sandbox }),
  };
  return ctx;
}
