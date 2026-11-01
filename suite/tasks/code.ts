import type { TaskContext } from '../../src/context.ts';
import type { Task } from '../../src/types.ts';
import { ok } from '../lib/helpers.ts';

const pyTest = async ({ hidden, sh }: TaskContext, name: string, body: string) => { await hidden(name, body); return sh(`python3 .hidden/${name}`); };
const nodeTest = async ({ hidden, sh }: TaskContext, name: string, body: string) => { await hidden(name, body); return sh(`node --test .hidden/${name}`); };

const INVENTORY = {
  'inventory/store.py': `class Store:
    def __init__(self):
        self.items = {}

    def add(self, sku, qty):
        self.items[sku] = self.items.get(sku, 0) + qty

    def remove(self, sku, qty):
        if self.items.get(sku, 0) < qty:
            raise ValueError("not enough stock")
        self.items[sku] -= qty

    def total(self):
        return sum(self.items.values())
`,
  'inventory/__init__.py': 'from .store import Store\n',
  'tests/test_store.py': `import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from inventory import Store

class StoreTest(unittest.TestCase):
    def test_add_remove(self):
        s = Store()
        s.add("a", 3)
        s.remove("a", 1)
        self.assertEqual(s.total(), 2)

if __name__ == "__main__":
    unittest.main()
`,
};

export default [
  {
    id: 'code-fix-median', version: 1, category: 'code', tier: 'simple', lang: 'fr', slop: { kind: 'code', files: ['stats.py'] },
    prompt: 'La fonction median de stats.py renvoie une mauvaise valeur pour les listes de taille paire. Corrige-la.',
    setup: ({ write }) => write('stats.py', 'def median(values):\n    s = sorted(values)\n    n = len(s)\n    return s[n // 2]\n'),
    check: async (t) => {
      const r = await pyTest(t, 't.py', 'import sys\nsys.path.insert(0, ".")\nfrom stats import median\nassert median([1, 2, 3, 4]) == 2.5\nassert median([3, 1, 2]) == 2\nassert median([5]) == 5\nassert median([2, 2]) == 2\n');
      return ok(r.code === 0, r.out.slice(-300));
    },
    solve: async ({ write }) => { await write('stats.py', 'def median(values):\n    s = sorted(values)\n    n = len(s)\n    if n % 2:\n        return s[n // 2]\n    return (s[n // 2 - 1] + s[n // 2]) / 2\n'); return 'Corrigé.'; },
  },
  {
    id: 'code-add-slugify', version: 1, category: 'code', tier: 'simple', lang: 'en', slop: { kind: 'code', files: ['lib/slug.js'] },
    prompt: 'Create lib/slug.js, an ES module exporting `slugify(text)`: lowercase, accents removed, anything that is not a letter or digit becomes a single hyphen, no hyphen at either end.',
    check: async (t) => {
      const r = await nodeTest(t, 't.test.mjs', `import test from 'node:test'; import assert from 'node:assert';
import { slugify } from '../lib/slug.js';
test('s', () => { assert.equal(slugify('Crème Brûlée!'), 'creme-brulee'); assert.equal(slugify('  a--b  c '), 'a-b-c'); assert.equal(slugify('Déjà_vu 2'), 'deja-vu-2'); });`);
      return ok(r.code === 0, r.out.slice(-300));
    },
    solve: async ({ write }) => { await write('lib/slug.js', "export const slugify = (t) => t.normalize('NFD').replace(/\\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n"); return 'Done.'; },
  },
  {
    id: 'code-failing-test', version: 1, category: 'code', tier: 'simple', lang: 'fr', slop: { kind: 'code', files: ['src/price.js'] },
    prompt: 'Le test de ce projet échoue (`node --test`). Trouve la cause et corrige le code, sans modifier le test.',
    setup: async ({ write }) => {
      await write('src/price.js', "export const withVat = (price, rate) => price * rate;\n");
      await write('src/cart.js', "import { withVat } from './price.js';\nexport const total = (lines) => lines.reduce((n, l) => n + withVat(l.price, 0.2) * l.qty, 0);\n");
      await write('test/cart.test.js', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { total } from '../src/cart.js';\ntest('total', () => assert.equal(Math.round(total([{ price: 10, qty: 2 }]) * 100) / 100, 24));\n");
    },
    check: async ({ sh, file }) => {
      const r = await sh('node --test');
      const test = await file('test/cart.test.js');
      return ok(r.code === 0 && test?.includes('24'), r.out.slice(-300));
    },
    solve: async ({ write }) => { await write('src/price.js', 'export const withVat = (price, rate) => price * (1 + rate);\n'); return 'Corrigé.'; },
  },
  {
    id: 'code-inventory-reservations', version: 1, category: 'code', tier: 'complex', lang: 'en', slop: { kind: 'code', files: ['inventory/store.py'] },
    prompt: 'Add reservations to the inventory package: `Store.reserve(sku, qty)` holds stock and returns an id, `Store.release(id)` gives it back, `Store.commit(id)` removes it for good, and `Store.available(sku)` is the stock not held. `remove` must not touch held stock (ValueError otherwise), `reserve` raises ValueError when not enough is available, an unknown or already used id raises KeyError. `total()` keeps counting held stock until it is committed. Keep the existing test passing and add your own.',
    testCommand: 'python3 tests/test_store.py',
    setup: async ({ write }) => { for (const [f, c] of Object.entries(INVENTORY)) await write(f, c); },
    check: async (t) => {
      const r = await pyTest(t, 't.py', `import sys
sys.path.insert(0, ".")
from inventory import Store
s = Store(); s.add("a", 5)
r = s.reserve("a", 3)
assert s.available("a") == 2 and s.total() == 5
try:
    s.remove("a", 3); raise SystemExit("remove took held stock")
except ValueError: pass
try:
    s.reserve("a", 3); raise SystemExit("over reserved")
except ValueError: pass
s.release(r); assert s.available("a") == 5
try:
    s.release(r); raise SystemExit("used id")
except KeyError: pass
r2 = s.reserve("a", 2); s.commit(r2)
assert s.total() == 3 and s.available("a") == 3
try:
    s.commit(r2); raise SystemExit("used id")
except KeyError: pass
`);
      const old = await t.sh('python3 tests/test_store.py');
      return ok(r.code === 0 && old.code === 0, (r.out + old.out).slice(-400));
    },
    solve: async ({ write }) => {
      await write('inventory/store.py', `import itertools

class Store:
    def __init__(self):
        self.items = {}
        self.held = {}
        self.ids = itertools.count(1)

    def add(self, sku, qty):
        self.items[sku] = self.items.get(sku, 0) + qty

    def available(self, sku):
        return self.items.get(sku, 0) - sum(q for s, q in self.held.values() if s == sku)

    def remove(self, sku, qty):
        if self.available(sku) < qty:
            raise ValueError("not enough stock")
        self.items[sku] -= qty

    def reserve(self, sku, qty):
        if self.available(sku) < qty:
            raise ValueError("not enough stock")
        i = next(self.ids)
        self.held[i] = (sku, qty)
        return i

    def release(self, i):
        del self.held[i]

    def commit(self, i):
        sku, qty = self.held.pop(i)
        self.items[sku] -= qty

    def total(self):
        return sum(self.items.values())
`);
      return 'Done.';
    },
  },
  {
    id: 'code-landing-page', version: 1, category: 'code', tier: 'complex', lang: 'fr', slop: { kind: 'frontend', files: ['index.html', 'style.css'] },
    prompt: 'Lis brief.txt et crée la page d\'accueil demandée : index.html et style.css, sans framework ni dépendance.',
    setup: ({ write }) => write('brief.txt', 'Fournil des Quais, boulangerie au levain à Nantes, 12 quai de la Fosse, ouverte du mardi au samedi de 7 h à 19 h. Tenue par Maïwenn Le Goff, ancienne charpentière de marine. Spécialité : la miche de seigle de deux kilos, vendue à la coupe. Le ton : artisanal, sobre, un peu bourru. Une seule page : qui on est, le pain, les horaires, l\'adresse.\n'),
    check: async ({ file }) => {
      const html = (await file('index.html')) ?? '';
      const css = (await file('style.css')) ?? '';
      const missing = [/Fournil des Quais/i, /12,? quai de la Fosse/i, /7 ?h/i, /19 ?h/i, /Ma[iï]wenn/i, /seigle/i].filter((r) => !r.test(html));
      return ok(!missing.length && /style\.css/.test(html) && css.length > 200, `manque : ${missing}, css ${css.length}`);
    },
    solve: async ({ write }) => {
      await write('index.html', '<!doctype html>\n<html lang="fr">\n<head><meta charset="utf-8"><title>Fournil des Quais</title><link rel="stylesheet" href="style.css"></head>\n<body>\n<h1>Fournil des Quais</h1>\n<p>Maïwenn Le Goff construisait des bateaux. Elle fait du pain au levain.</p>\n<h2>Le pain</h2>\n<p>La miche de seigle de deux kilos, vendue à la coupe.</p>\n<h2>Horaires</h2>\n<p>Du mardi au samedi, de 7 h à 19 h.</p>\n<address>12 quai de la Fosse, Nantes</address>\n</body>\n</html>\n');
      await write('style.css', 'body { max-width: 34rem; margin: 3rem auto; padding: 0 1rem; font: 18px/1.6 Georgia, serif; color: #2a2118; background: #f4efe6; }\nh1 { font-size: 2.6rem; margin-bottom: .5rem; }\nh2 { margin-top: 2.5rem; border-top: 2px solid #2a2118; padding-top: .5rem; }\naddress { font-style: normal; }\n');
      return 'Page créée.';
    },
  },
] satisfies Task[];
