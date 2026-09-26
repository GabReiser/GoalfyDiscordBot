/**
 * Testes da integração com a Goalfy usando os formatos REAIS das respostas
 * (DTOs do goalfy-service), que em vários pontos diferem da documentação pública.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoardService } from '../src/goalfy/board.js';
import { CardService } from '../src/goalfy/cards.js';
import type { GoalfyClient } from '../src/goalfy/client.js';
import { commentText, parseApiDate, toCard, toCardPage, toComments } from '../src/goalfy/types.js';

const phases = [
  { id: 'p1', index: 0, title: 'Backlog / Planned', modelId: 'mp1', done: false, archived: false },
  { id: 'p2', index: 1, title: 'Desenvolvimento', modelId: 'mp2', done: false, archived: false },
  { id: 'p9', index: 2, title: 'Arquivada', done: false, archived: true },
  { id: 'p3', index: 3, title: 'Produção', modelId: 'mp3', done: true, archived: false },
];

const boardFields = [
  {
    id: 'MODEL-INICIAL',
    name: 'Formulário Inicial',
    fields: [
      { id: 'f-titulo', title: 'Título', fieldType: 'shortText', options: [] },
      { id: 'f-desc', title: 'Descrição', fieldType: 'longText', options: [] },
      { id: 'f-tipo', title: 'Tipo', fieldType: 'singleSelect', options: ['Bug', 'Melhoria'] },
      { id: 'f-sev', title: 'Severidade', fieldType: 'singleSelect', options: ['S1 - Crítico', 'S2 - Alto', 'S3 - Médio', 'S4 - Baixo'] },
      { id: 'f-frente', title: 'Frente', fieldType: 'checkbox', options: ['Sustentação', 'Engenharia', 'Produto'] },
    ],
  },
  { id: 'p1', name: 'Backlog / Planned', fields: [{ id: 'f-outro', title: 'Estimativa', fieldType: 'number', options: [] }] },
];

function fakeGoalfy() {
  const calls: { op: string; args: unknown[] }[] = [];
  const log = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const client = {
    listPhases: async () => phases,
    getBoardFields: async () => boardFields,
    filterCards: async (_b: string, f: unknown) => {
      log('filter', f);
      return { cards: [{ id: 'c1', title: 'A', phaseId: 'p2', tags: [{ text: 'bug' }], responsibles: [{ name: 'Ana' }] }], cardsCount: 31 };
    },
    createCard: async (modelId: string, fields: unknown) => {
      log('create', modelId, fields);
      return { id: 'NEW', title: '', phaseId: 'p1' };
    },
    setCardTitle: async (_id: string, title: string) => log('title', title),
    addComment: async (_id: string, body: string) => log('comment', body),
    getCard: async (id: string) => ({ id, title: 'X', phase: { id: 'p1', title: 'Backlog / Planned' }, tags: [], responsibles: [] }),
  };
  return { client: client as unknown as GoalfyClient, calls };
}

const config = { GOALFY_BOARD_ID: 'B1', GOALFY_APP_URL: 'https://app.goalfy.com.br', GOALFY_DONE_PHASES: [] as string[] };
const boardFor = (client: GoalfyClient, extra: Partial<typeof config> = {}) =>
  new BoardService(client, { ...config, ...extra } as never);

describe('normalizadores', () => {
  it('lê datas sem fuso como UTC (a API serializa em UTC sem sufixo)', () => {
    assert.equal(parseApiDate('2026-06-03T10:00:00.000')?.toISOString(), '2026-06-03T10:00:00.000Z');
    assert.equal(parseApiDate('2026-06-03T10:00:00-03:00')?.toISOString(), '2026-06-03T13:00:00.000Z');
    assert.equal(parseApiDate('lixo'), undefined);
  });

  it('lê card do GET /cards/{id} (fase como objeto, tags com `text`)', () => {
    const card = toCard({ id: 7, title: 'T', phase: { id: 'p2', title: 'Dev' }, tags: [{ text: 'bug' }], responsibles: [{ name: 'Ana' }] });
    assert.deepEqual([card?.id, card?.phaseId, card?.phaseName, card?.tags, card?.responsibles], ['7', 'p2', 'Dev', ['bug'], ['Ana']]);
  });

  it('lê a página do filtro com o total (`cardsCount`)', () => {
    const page = toCardPage({ cards: [{ id: 1 }, { id: 2 }], cardsCount: 40 });
    assert.equal(page.cards.length, 2);
    assert.equal(page.total, 40);
  });

  it('extrai o texto de comentários do editor (Draft.js)', () => {
    assert.equal(commentText('{"entityMap":{},"blocks":[{"text":"linha 1"},{"text":"linha 2"}]}'), 'linha 1\nlinha 2');
    assert.equal(commentText('texto puro'), 'texto puro');
    const [c] = toComments({ comments: [{ id: 'x', body: 'oi', author: { username: 'dev' } }] });
    assert.equal(c?.author, 'dev');
  });
});

describe('BoardService', () => {
  it('cria cards pelo "Formulário Inicial" do board, não pelo formulário da 1ª fase', async () => {
    const { client } = fakeGoalfy();
    const form = await boardFor(client).createForm();
    assert.equal(form.modelId, 'MODEL-INICIAL');
    assert.equal(form.fields.title?.fieldInfoId, 'f-titulo');
    assert.equal(form.fields.severity?.fieldInfoId, 'f-sev');
    assert.equal(form.fields.front?.fieldInfoId, 'f-frente');
  });

  it('ignora fases arquivadas e usa a flag `done`', async () => {
    const { client } = fakeGoalfy();
    const board = boardFor(client);
    const list = await board.phases();
    assert.deepEqual(list.map((p) => p.id), ['p1', 'p2', 'p3']);
    assert.deepEqual(list.map((p) => board.isDone(p)), [false, false, true]);
  });

  it('GOALFY_DONE_PHASES tem prioridade sobre a flag `done`', async () => {
    const { client } = fakeGoalfy();
    const board = boardFor(client, { GOALFY_DONE_PHASES: ['Desenvolvimento'] });
    const list = await board.phases();
    assert.deepEqual(list.map((p) => board.isDone(p)), [false, true, false]);
  });

  it('converte página 1 da UI para offset 0 da API e preenche o nome da fase', async () => {
    const { client, calls } = fakeGoalfy();
    const result = await boardFor(client).searchCards({ page: 1, limit: 10, search: 'x' });
    assert.equal((calls.at(-1)?.args[0] as { offset: number }).offset, 0);
    assert.equal(result.total, 31);
    assert.equal(result.cards[0]?.phaseName, 'Desenvolvimento');
  });
});

describe('CardService.create', () => {
  const input = {
    title: 'Erro 500 ao salvar',
    description: 'Detalhes',
    front: 'Sustentação',
    type: 'Regressão',
    origin: 'Suporte',
    severity: 'S2 — Alto',
    requester: 'Ana',
    discordLink: 'https://discord.com/channels/1/2',
  };

  it('casa valores com as opções dos campos e manda o resto como comentário', async () => {
    const { client, calls } = fakeGoalfy();
    await new CardService(client, boardFor(client)).create(input);

    const create = calls.find((c) => c.op === 'create')!;
    assert.equal(create.args[0], 'MODEL-INICIAL');
    const values = Object.fromEntries((create.args[1] as { fieldInfoId: string; value: unknown }[]).map((f) => [f.fieldInfoId, f.value]));
    assert.equal(values['f-sev'], 'S2 - Alto', 'travessão/acento não impedem o match');
    assert.deepEqual(values['f-frente'], ['Sustentação'], 'checkbox é array');
    assert.equal(values['f-tipo'], undefined, '"Regressão" não é opção do campo Tipo');

    const comment = calls.find((c) => c.op === 'comment')!.args[0] as string;
    assert.match(comment, /\*\*Tipo:\*\* Regressão/);
    assert.match(comment, /\*\*Origem:\*\* Suporte/);
  });

  it('prefixa o tipo no título quando ele não ficou em um campo', async () => {
    const { client, calls } = fakeGoalfy();
    const cards = new CardService(client, boardFor(client));
    await cards.create(input);
    assert.equal(calls.find((c) => c.op === 'title')!.args[0], '[Regressão] Erro 500 ao salvar');

    calls.length = 0;
    await cards.create({ ...input, type: 'Bug' });
    assert.equal(calls.find((c) => c.op === 'title')!.args[0], 'Erro 500 ao salvar');
  });
});
