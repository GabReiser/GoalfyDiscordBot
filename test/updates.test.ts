/**
 * Novidades: cada entrada do changelog é anunciada uma vez só, da mais antiga para a mais nova.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANGELOG } from '../src/changelog.js';
import { markPosted, pendingEntries, updateEmbed } from '../src/discord/updates.js';
import { Store } from '../src/store.js';

const entries = [
  { id: 'c', title: 'C', body: ['nova'] },
  { id: 'b', title: 'B', body: ['meio'] },
  { id: 'a', title: 'A', body: ['antiga'] },
];

describe('novidades', () => {
  it('posta só o que falta, da mais antiga para a mais nova', () => {
    const store = new Store(':memory:');
    assert.deepEqual(pendingEntries(store, entries).map((e) => e.id), ['a', 'b', 'c']);
    markPosted(store, ['a', 'b']);
    assert.deepEqual(pendingEntries(store, entries).map((e) => e.id), ['c']);
    markPosted(store, ['c']);
    assert.deepEqual(pendingEntries(store, entries), []);
  });

  it('changelog real: ids únicos e textos dentro dos limites do Discord', () => {
    const ids = CHANGELOG.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const e of CHANGELOG) {
      const json = updateEmbed(e).toJSON();
      assert.ok(json.title!.length <= 256 && json.description!.length <= 4096, e.id);
    }
  });
});
