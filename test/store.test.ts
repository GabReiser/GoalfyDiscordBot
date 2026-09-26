import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Store } from '../src/store.js';

describe('Store', () => {
  it('registra destino dos tópicos e calcula os indicadores', () => {
    const s = new Store(':memory:');
    s.openTopic('t1', 'u1', 'Bug no funil');
    s.openTopic('t2', 'u2', 'Dúvida');
    s.openTopic('t3', 'u3', 'Pendente');

    s.setStatus('t1', 'card', true);
    s.classify('t1', { Tipo: 'Bug', Origem: 'Suporte', 'Prioridade especial': 'Major' });
    s.link({ threadId: 't1', cardId: 'c1', channelId: 'f', createdBy: 'u1', phaseId: null, phaseName: null });
    s.setStatus('t2', 'resolved', true);
    s.setStatus('t3', 'waiting', false);

    assert.deepEqual(s.pendingTopics().map((t) => t.threadId), ['t3']);
    const r = s.report(new Date(0).toISOString());
    assert.equal(r.opened, 3);
    assert.equal(r.cards, 1);
    assert.equal(r.resolvedInTriage, 1);
    assert.equal(r.pending, 1);
    assert.deepEqual(r.byField, { Tipo: { Bug: 1 }, Origem: { Suporte: 1 }, 'Prioridade especial': { Major: 1 } });
  });

  it('só devolve comentários ainda não vistos', () => {
    const s = new Store(':memory:');
    assert.deepEqual([...s.markSeen('c1', ['a', 'b'])], ['a', 'b']);
    assert.deepEqual([...s.markSeen('c1', ['b', 'c'])], ['c']);
  });

  it('guarda chave-valor', () => {
    const s = new Store(':memory:');
    s.set('k', '1');
    s.set('k', '2');
    assert.equal(s.get('k'), '2');
    assert.equal(s.get('nada'), undefined);
  });
});
