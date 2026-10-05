/**
 * Abrir o card numa fase específica: quais fases a triagem pode escolher e o que vai para a API.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { draftMessage, phaseModal } from '../src/discord/ui.js';
import { BoardService } from '../src/goalfy/board.js';
import { CardService } from '../src/goalfy/cards.js';
import type { GoalfyClient } from '../src/goalfy/client.js';

// Fases do Backlog Produto (produção), com o flag "criar card direto" de cada uma
const phases = [
  { id: 'p0', index: 0, title: 'Backlog', allowDirectCardCreation: false },
  { id: 'p1', index: 1, title: 'Em Análise', allowDirectCardCreation: false },
  { id: 'p2', index: 2, title: 'Priorizado', allowDirectCardCreation: true },
  { id: 'p3', index: 3, title: 'Pronto para Dev', allowDirectCardCreation: false },
  { id: 'p8', index: 8, title: 'Em Produção', allowDirectCardCreation: true, done: true },
  { id: 'p9', index: 9, title: 'Cancelado/Arquivado', allowDirectCardCreation: false, done: true },
];

function setup(createPhases: string[] = []) {
  const calls: unknown[][] = [];
  const client = {
    listPhases: async () => phases,
    getBoardFields: async () => [{ id: 'MODEL', name: 'Formulário Inicial', fields: [] }],
    createCard: async (...args: unknown[]) => {
      calls.push(args);
      return { id: 'NEW' };
    },
    setCardTitle: async () => {},
    addComment: async () => {},
    getCard: async (id: string) => ({ id, title: 'x', phase: { id: 'p2' } }),
  } as unknown as GoalfyClient;
  const board = new BoardService(client, {
    GOALFY_BOARD_ID: 'B1',
    GOALFY_APP_URL: 'https://app',
    GOALFY_DONE_PHASES: [],
    GOALFY_RESPONSIBLES: [],
    GOALFY_CREATE_PHASES: createPhases,
  } as never);
  return { client, board, calls };
}

describe('fases em que o card pode nascer', () => {
  it('inicial sempre + as liberadas na Goalfy; nunca fase final', async () => {
    const { board } = setup();
    assert.deepEqual((await board.creatablePhases()).map((p) => p.title), ['Backlog', 'Priorizado']);
  });

  it('GOALFY_CREATE_PHASES libera outras, por nome (sem acento/caixa) ou ID', async () => {
    const { board } = setup(['pronto para dev', 'p1', 'Cancelado/Arquivado']);
    assert.deepEqual((await board.creatablePhases()).map((p) => p.title), ['Backlog', 'Em Análise', 'Priorizado', 'Pronto para Dev']);
  });

  it('sem nenhuma liberada, só a inicial', async () => {
    const { board, client } = setup();
    (client as unknown as { listPhases: () => Promise<unknown> }).listPhases = async () => phases.map((p) => ({ ...p, allowDirectCardCreation: false }));
    assert.deepEqual((await board.creatablePhases()).map((p) => p.title), ['Backlog']);
  });

  it('cria o card na fase escolhida (phaseId vai para a API)', async () => {
    const { client, board, calls } = setup();
    await new CardService(client, board).create({ title: 'T', values: {}, requester: 'Ana', phaseId: 'p2' });
    assert.equal(calls[0]![2], 'p2');
  });
});

describe('telas', () => {
  it('resumo mostra a fase; botão "Alterar fase" só quando há escolha', () => {
    const json = (canChange: boolean) => {
      const m = draftMessage([], {}, 'classified', undefined, { title: 'Priorizado', canChange });
      const labels = (m.components[0]!.toJSON() as unknown as { components: { label?: string }[] }).components.map((c) => c.label);
      return { description: m.embeds[0]!.toJSON().description!, labels };
    };
    assert.match(json(true).description, /Fase em que o card nasce:\*\* Priorizado/);
    assert.ok(json(true).labels.includes('Alterar fase'));
    assert.ok(!json(false).labels.includes('Alterar fase'));
  });

  it('modal de fase marca a atual', () => {
    const m = phaseModal(
      [
        { id: 'p0', title: 'Backlog' },
        { id: 'p2', title: 'Priorizado' },
      ],
      'p2',
    ).toJSON() as unknown as { components: { component: { options: { value: string; default?: boolean }[] } }[] };
    const opts = m.components[0]!.component.options;
    assert.deepEqual(opts.filter((o) => o.default).map((o) => o.value), ['p2']);
  });
});
