import { ok } from '../lib/helpers.js';

const base = async ({ write, git }) => {
  await git('init', '-q');
  await write('a.txt', 'one\n');
  await write('b.txt', 'two\n');
  await git('add', '.');
  await git('commit', '-qm', 'first');
};

export default [
  {
    id: 'git-selective-commit', version: 1, category: 'terminal', tier: 'simple', lang: 'fr',
    prompt: 'a.txt et b.txt sont modifiés. Commite uniquement a.txt, avec le message exact "fix: update a". b.txt doit rester modifié et non commité.',
    setup: async (t) => { await base(t); await t.write('a.txt', 'one!\n'); await t.write('b.txt', 'two!\n'); },
    check: async ({ gitOut }) => {
      const msg = await gitOut('log', '-1', '--format=%s');
      const files = await gitOut('show', '--name-only', '--format=', 'HEAD');
      const status = await gitOut('status', '--porcelain');
      return ok(msg === 'fix: update a' && files === 'a.txt' && /b\.txt/.test(status), `${msg} | ${files} | ${status}`);
    },
    solve: async ({ git }) => { await git('add', 'a.txt'); await git('commit', '-qm', 'fix: update a'); return 'Fait.'; },
  },
  {
    id: 'git-undo-last-commit', version: 1, category: 'terminal', tier: 'simple', lang: 'en',
    prompt: 'I committed too early. Undo the last commit but keep its changes in the working tree or the index: nothing must be lost.',
    setup: async (t) => { await base(t); await t.write('c.txt', 'keep me\n'); await t.git('add', '.'); await t.git('commit', '-qm', 'too early'); },
    check: async ({ gitOut, file }) => {
      const log = await gitOut('log', '--format=%s');
      return ok(log === 'first' && (await file('c.txt')) === 'keep me\n', log);
    },
    solve: async ({ git }) => { await git('reset', '--soft', 'HEAD~1'); return 'Done.'; },
  },
  {
    id: 'git-stash-hotfix', version: 1, category: 'terminal', tier: 'simple', lang: 'fr',
    prompt: 'J\'ai du travail en cours sur a.txt, non commité. Sans le perdre ni le commiter : crée la branche hotfix depuis main, ajoute-y un fichier fix.txt contenant "ok" et commite-le, reviens sur main, et restaure mon travail en cours.',
    setup: async (t) => { await base(t); await t.write('a.txt', 'work in progress\n'); },
    check: async ({ gitOut, file }) => {
      const branch = await gitOut('branch', '--show-current');
      const onHotfix = await gitOut('show', 'hotfix:fix.txt');
      const main = await gitOut('log', 'main', '--format=%s');
      const stash = await gitOut('stash', 'list');
      return ok(branch === 'main' && onHotfix === 'ok' && main === 'first' && (await file('a.txt')) === 'work in progress\n' && !stash, `${branch} | ${main}`);
    },
    solve: async ({ git, write }) => { await git('stash'); await git('checkout', '-qb', 'hotfix'); await write('fix.txt', 'ok\n'); await git('add', '.'); await git('commit', '-qm', 'fix'); await git('checkout', '-q', 'main'); await git('stash', 'pop', '-q'); return 'Fait.'; },
  },
  {
    id: 'shell-count-todos', version: 1, category: 'terminal', tier: 'simple', lang: 'en',
    prompt: 'Count the lines containing TODO across all .py files of this project, subfolders included, ignoring the `vendor` folder. Write only the number to count.txt.',
    setup: async ({ write }) => {
      await write('a.py', '# TODO one\nx = 1\n# TODO two\n');
      await write('pkg/b.py', 'y = 2  # TODO three\n');
      await write('pkg/deep/c.py', '# nothing\n');
      await write('vendor/d.py', '# TODO not this\n');
      await write('notes.txt', 'TODO not this either\n');
    },
    check: async ({ file }) => ok((await file('count.txt'))?.trim() === '3', await file('count.txt')),
    solve: async ({ write }) => { await write('count.txt', '3\n'); return 'Done.'; },
  },
  {
    id: 'git-rebase-conflict', version: 1, category: 'terminal', tier: 'complex', lang: 'fr',
    prompt: 'Rebase la branche feature sur main. Il y aura un conflit dans config.txt : garde les deux réglages (timeout de main, retries de feature). L\'historique final de feature doit être linéaire, sans commit de merge, et les deux commits de feature doivent rester distincts. Reste sur feature à la fin.',
    setup: async ({ write, git }) => {
      await git('init', '-q');
      await write('config.txt', 'name=app\n');
      await git('add', '.'); await git('commit', '-qm', 'init');
      await git('checkout', '-qb', 'feature');
      await write('config.txt', 'name=app\nretries=3\n');
      await git('add', '.'); await git('commit', '-qm', 'add retries');
      await write('feature.txt', 'f\n');
      await git('add', '.'); await git('commit', '-qm', 'add feature file');
      await git('checkout', '-q', 'main');
      await write('config.txt', 'name=app\ntimeout=30\n');
      await git('add', '.'); await git('commit', '-qm', 'add timeout');
      await git('checkout', '-q', 'feature');
    },
    check: async ({ gitOut, file }) => {
      const cfg = (await file('config.txt')) ?? '';
      const log = await gitOut('log', '--format=%s');
      const merges = await gitOut('log', '--merges', '--format=%h');
      const main = await gitOut('rev-parse', 'main');
      const base = await gitOut('merge-base', 'main', 'feature');
      const state = await gitOut('status', '--porcelain', '--branch');
      return ok(/timeout=30/.test(cfg) && /retries=3/.test(cfg) && !/[<>]{7}/.test(cfg) && !merges && main === base && log.split('\n').length === 4 && /## feature/.test(state), log);
    },
    solve: async ({ git, write }) => { await git('rebase', 'main').catch(() => {}); await write('config.txt', 'name=app\ntimeout=30\nretries=3\n'); await git('add', '.'); await git('-c', 'core.editor=true', 'rebase', '--continue'); return 'Fait.'; },
  },
  {
    id: 'git-recover-reset', version: 1, category: 'terminal', tier: 'complex', lang: 'en',
    prompt: 'I ran `git reset --hard HEAD~2` by mistake and lost my last two commits. Recover them on a new branch named `rescue` without changing `main`, and tell me the subject of the two commits.',
    setup: async (t) => {
      await base(t);
      await t.write('c.txt', '1\n'); await t.git('add', '.'); await t.git('commit', '-qm', 'add parser');
      await t.write('d.txt', '2\n'); await t.git('add', '.'); await t.git('commit', '-qm', 'add lexer');
      await t.git('reset', '-q', '--hard', 'HEAD~2');
    },
    check: async ({ gitOut, answer }) => {
      const rescue = await gitOut('log', 'rescue', '--format=%s').catch(() => '');
      const main = await gitOut('log', 'main', '--format=%s');
      return ok(rescue.startsWith('add lexer\nadd parser') && main === 'first' && /parser/.test(answer) && /lexer/.test(answer), rescue);
    },
    solve: async ({ git }) => { await git('branch', 'rescue', 'HEAD@{1}'); return 'Recovered: add parser, add lexer.'; },
  },
];
