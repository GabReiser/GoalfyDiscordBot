/**
 * Responsável na abertura do card: quem aparece na lista, onde o campo entra no modal 2
 * e como ele é enviado para a Goalfy (addResponsible com o e-mail do membro).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CreateForm } from '../src/goalfy/board.js';
import { BoardService } from '../src/goalfy/board.js';
import { CardService } from '../src/goalfy/cards.js';
import type { GoalfyClient } from '../src/goalfy/client.js';
import { planCreate, RESPONSIBLE_FIELD_ID } from '../src/goalfy/formPlan.js';
import { type FormField, type Phase, toMembers } from '../src/goalfy/types.js';

const membersResponse = {
  members: [
    { id: 'u-bot', name: 'Bot Discord', email: 'bot@goalfy.com', role: 'ADMIN', status: 'ACCEPTED', isCurrentUser: true },
    { id: 'u-gus', name: 'Gus', email: 'gus@goalfy.com', role: 'ADMIN', status: 'ACCEPTED', isCurrentUser: false },
    { id: 'u-doug', name: 'Douglas Maia', email: 'doug@goalfy.com', role: 'ADMIN', status: 'ACCEPTED', isCurrentUser: false },
    { id: 'u-ana1', name: 'Ana', email: 'ana.silva@goalfy.com', role: 'ADMIN', status: 'ACCEPTED', isCurrentUser: false },
    { id: 'u-ana2', name: 'Ana', email: 'ana.souza@goalfy.com', role: 'ADMIN', status: 'ACCEPTED', isCurrentUser: false },
    { id: 'u-conv', name: 'Convidado', email: 'conv@x.com', role: 'USER', status: 'PENDING', isCurrentUser: false },
  ],
  total: 6,
};

function setup(responsibles: string[] = []) {
  const calls: string[] = [];
  const client = {
    listMembers: async () => membersResponse,
    addResponsible: async (cardId: string, value: string) => calls.push(`addResponsible ${cardId} ${value}`),
  } as unknown as GoalfyClient;
  const board = new BoardService(client, { GOALFY_BOARD_ID: 'B1', GOALFY_APP_URL: 'https://app', GOALFY_DONE_PHASES: [], GOALFY_RESPONSIBLES: responsibles } as never);
  return { client, board, calls };
}

describe('lista de responsáveis', () => {
  it('lê os membros do board', () => {
    const m = toMembers(membersResponse);
    assert.equal(m.length, 6);
    assert.deepEqual(m[0], { id: 'u-bot', name: 'Bot Discord', email: 'bot@goalfy.com', isCurrentUser: true, accepted: true });
  });

  it('só membros ativos, sem o próprio bot, em ordem alfabética; nomes repetidos ganham o e-mail', async () => {
    const { board } = setup();
    const r = (await board.responsibleField())!;
    assert.deepEqual(r.field.options, ['Ana (ana.silva@goalfy.com)', 'Ana (ana.souza@goalfy.com)', 'Douglas Maia', 'Gus']);
    assert.equal(r.emailByLabel.get('Gus'), 'gus@goalfy.com');
    assert.equal(r.field.fieldInfoId, RESPONSIBLE_FIELD_ID);
    assert.equal(r.field.required, false);
  });

  it('GOALFY_RESPONSIBLES restringe a lista (ex.: só os devs)', async () => {
    const { board } = setup(['GUS@goalfy.com', 'doug@goalfy.com']);
    assert.deepEqual((await board.responsibleField())!.field.options, ['Douglas Maia', 'Gus']);
  });

  it('envia o e-mail do membro para a Goalfy', async () => {
    const { client, board, calls } = setup();
    await new CardService(client, board).addResponsible('c1', 'gus@goalfy.com');
    assert.deepEqual(calls, ['addResponsible c1 gus@goalfy.com']);
  });
});

describe('posição no modal 2 (formulário de produção)', () => {
  const field = (index: number, name: string, type: string, required: boolean, options: string[] = []): FormField => ({
    fieldInfoId: `f${index}`,
    name,
    type,
    required,
    options,
    index,
  });
  const titulo = field(0, 'Título da tarefa', 'shorttext', true);
  const descricao = field(1, 'Descrição', 'longtext', true);
  const form: CreateForm = {
    modelId: 'M',
    initialPhase: { id: 'b', title: 'Backlog', index: 0, archived: false } as Phase,
    fields: { title: titulo, description: descricao },
    allFields: [
      titulo,
      descricao,
      field(2, 'E-mail do solicitante', 'email', true),
      field(3, 'Link RFC', 'shorttext', false),
      field(4, 'Qual cliente?', 'shorttext', false),
      field(5, 'Link do figma (dev)', 'shorttext', false),
      field(6, 'Origem', 'singleselect', true, ['Suporte/CS']),
    ],
  };
  const responsible = field(99, 'Responsável (quem vai desenvolver)', 'singleselect', false, ['Gus', 'Douglas Maia']);

  it('entra logo depois dos obrigatórios, antes dos links', () => {
    const plan = planCreate(form, { ...responsible, fieldInfoId: RESPONSIBLE_FIELD_ID });
    assert.deepEqual(plan.modal.map((f) => f.name), [
      'Descrição',
      'E-mail do solicitante',
      'Responsável (quem vai desenvolver)',
      'Link RFC',
      'Qual cliente?',
    ]);
    assert.ok(plan.skipped.some((f) => f.name === 'Link do figma (dev)'));
  });

  it('sem membros disponíveis, o modal fica como antes', () => {
    assert.ok(!planCreate(form).modal.some((f) => f.fieldInfoId === RESPONSIBLE_FIELD_ID));
  });
});
