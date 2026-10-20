/**
 * /topicos: lista dos tópicos abertos de quem abriu (etiquetas, status, card na Goalfy).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { topicLine, topicsEmbed, type TopicItem } from '../src/discord/myTopics.js';
import { Store } from '../src/store.js';

const base: TopicItem = { threadId: '100', title: 'Erro ao salvar meta', createdAt: new Date('2026-10-18T12:00:00Z'), archived: false, tags: [] };

describe('linha de cada tópico', () => {
  it('mostra status, link do tópico, etiquetas, card com a fase e quando abriu', () => {
    const line = topicLine({
      ...base,
      tags: ['Major', 'Card Criado'],
      status: 'card',
      card: { cardId: '42', phaseName: 'Em desenvolvimento', closed: false, url: 'https://app/board/B/cards/42' },
    });
    assert.match(line, /^📋 <#100> \*\*Erro ao salvar meta\*\*/);
    assert.match(line, /🏷️ Major, Card Criado/);
    assert.match(line, /\[#42\]\(https:\/\/app\/board\/B\/cards\/42\) · _Em desenvolvimento_/);
    assert.match(line, /aberto <t:\d+:R>/);
  });

  it('sem card, sem etiqueta e arquivado ficam explícitos', () => {
    const line = topicLine({ ...base, archived: true });
    assert.match(line, /_\(arquivado\)_/);
    assert.match(line, /_sem etiqueta_/);
    assert.match(line, /_sem card_/);
  });
});

describe('resumo', () => {
  it('mais recentes primeiro e contagem com/sem card', () => {
    const old = { ...base, threadId: '1', createdAt: new Date('2026-10-01T00:00:00Z') };
    const recent = { ...base, threadId: '2', createdAt: new Date('2026-10-19T00:00:00Z'), card: { cardId: '9', phaseName: null, closed: false, url: 'u' } };
    const e = topicsEmbed([old, recent], 'Ana', true).toJSON();
    assert.ok(e.description!.indexOf('<#2>') < e.description!.indexOf('<#1>'));
    assert.equal(e.title, '🧵 Seus tópicos abertos (2)');
    assert.equal(e.footer?.text, '1 com card na Goalfy · 1 sem card');
  });

  it('lista vazia e lista de outra pessoa', () => {
    assert.match(topicsEmbed([], 'Ana', true).toJSON().description!, /Você não tem tópicos abertos/);
    assert.equal(topicsEmbed([], 'Ana', false).toJSON().title, '🧵 Tópicos abertos de Ana (0)');
  });
});

describe('tópicos acompanhados no banco (mesmo arquivados pelo Discord)', () => {
  it('sem destino ou com card ainda aberto entram; resolvidos e cards finalizados saem', () => {
    const store = new Store(':memory:');
    const open = (id: string, owner = 'ANA') => store.openTopic(id, owner, `t${id}`);
    open('t-triagem');
    open('t-resolvido');
    store.setStatus('t-resolvido', 'resolved', true);
    open('t-card-aberto');
    store.setStatus('t-card-aberto', 'card', true);
    store.link({ threadId: 't-card-aberto', cardId: 'c1', channelId: 'f', createdBy: 'X', phaseId: null, phaseName: null });
    open('t-card-final');
    store.setStatus('t-card-final', 'card', true);
    store.link({ threadId: 't-card-final', cardId: 'c2', channelId: 'f', createdBy: 'X', phaseId: null, phaseName: null });
    store.updatePhase('c2', 'p9', 'Produção', true);
    open('t-outra-pessoa', 'BIA');

    assert.deepEqual(store.trackedTopicsOf('ANA').sort(), ['t-card-aberto', 't-triagem']);
  });
});
