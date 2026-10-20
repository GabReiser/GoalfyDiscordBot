/**
 * /topicos: lista enxuta dos tópicos de quem abriu, com filtros (abertos, sem resposta, com card…).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyFilter, topicLine, topicsView, type TopicItem } from '../src/discord/myTopics.js';
import { Store } from '../src/store.js';

const base: TopicItem = { threadId: '100', createdAt: new Date('2026-10-18T12:00:00Z'), archived: false, tags: [], finished: false, answered: true };

const triagem: TopicItem = { ...base, threadId: '1', status: 'triage', answered: false, tags: ['Atenção Especial'] };
const comCard: TopicItem = { ...base, threadId: '2', status: 'card', card: { url: 'https://app/board/B/cards/uuid', phaseName: 'Em QA' } };
const resolvido: TopicItem = { ...base, threadId: '3', status: 'resolved', finished: true, answered: undefined };
const respondido: TopicItem = { ...base, threadId: '4', status: 'waiting' };
const all = [triagem, comCard, resolvido, respondido];

describe('linha de cada tópico (enxuta)', () => {
  it('status, tópico, fase do card como link, etiquetas extras, sem resposta e idade', () => {
    assert.match(topicLine(comCard), /^📋 <#2> · \[Em QA\]\(https:\/\/app\/board\/B\/cards\/uuid\) · <t:\d+:R>$/);
    assert.match(topicLine(triagem), /^🔎 <#1> · Atenção Especial · 💬 sem resposta · <t:\d+:R>$/);
  });

  it('não repete o título nem mostra o ID (UUID) do card', () => {
    assert.ok(!topicLine(comCard).includes('uuid]'));
  });
});

describe('filtros', () => {
  const ids = (f: Parameters<typeof applyFilter>[1]) => applyFilter(all, f).map((t) => t.threadId);
  it('em aberto tira resolvidos/encerrados', () => assert.deepEqual(ids('abertos'), ['1', '2', '4']));
  it('sem resposta', () => assert.deepEqual(ids('sem_resposta'), ['1']));
  it('com card', () => assert.deepEqual(ids('com_card'), ['2']));
  it('encerrados', () => assert.deepEqual(ids('encerrados'), ['3']));
  it('todos', () => assert.equal(ids('todos').length, 4));
});

describe('resposta', () => {
  it('título com o filtro, rodapé com os totais e botões de filtro (o atual desabilitado)', () => {
    const v = topicsView(all, 'abertos', 'ANA', 'Ana', true);
    const e = v.embeds[0]!.toJSON();
    assert.equal(e.title, '🧵 Seus tópicos · Em aberto (3)');
    assert.match(e.footer!.text, /^3 em aberto · 1 sem resposta · 1 encerrado/);
    const buttons = v.components[0]!.toJSON().components as { custom_id: string; disabled?: boolean }[];
    assert.equal(buttons.length, 5);
    assert.equal(buttons.find((b) => b.disabled)?.custom_id, 'topics:abertos:ANA');
  });

  it('de outra pessoa e lista vazia', () => {
    const e = topicsView([], 'sem_resposta', 'BIA', 'Bia', false).embeds[0]!.toJSON();
    assert.equal(e.title, '🧵 Tópicos de Bia · Sem resposta (0)');
    assert.match(e.description!, /Nenhum tópico neste filtro/);
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
