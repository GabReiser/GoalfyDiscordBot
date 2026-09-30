/**
 * Plano de coleta usando o formulário REAL do board "Backlog Produto" (produção) e
 * as fases com formulário dele.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CreateForm } from '../src/goalfy/board.js';
import { fieldKind, matchOption, planCreate, planMoveFields } from '../src/goalfy/formPlan.js';
import type { FormField, Phase } from '../src/goalfy/types.js';
import { suggestSelects, suggestTexts } from '../src/discord/triage.js';
import { cardModal, classifyModal, draftMessage } from '../src/discord/ui.js';

const field = (index: number, name: string, type: string, required: boolean, options: string[] = []): FormField => ({
  fieldInfoId: `f${index}`,
  name,
  type,
  required,
  options,
  index,
});

// Formulário Inicial do "Backlog Produto"
const titulo = field(0, 'Título da tarefa', 'shorttext', true);
const origem = field(1, 'Origem', 'singleselect', true, ['Suporte', 'Consultoria', 'Produto', 'Interno', 'Outra']);
const tipo = field(2, 'Tipo', 'singleselect', true, ['Bug', 'Regressão', 'Melhoria', 'Feature', 'DevOps']);
const modulo = field(3, 'Módulo/Funcionalidade', 'singleselect', true, ['Board/Kanban', 'AI Studio/Copilot', 'Automation/Flows', 'Home']);
const prioridade = field(4, 'Prioridade especial', 'singleselect', true, ['Nenhuma', 'Atenção Especial', 'Major']);
const descricao = field(5, 'Descrição', 'longtext', true);
const figma = field(6, 'Link do figma (dev)', 'shorttext', false);
const rfc = field(7, 'Link RFC', 'shorttext', false);
const anexo = field(8, 'Anexo', 'attachment', false);

const backlogProduto: CreateForm = {
  modelId: 'MODEL',
  initialPhase: { id: 'backlog', title: 'Backlog', index: 0, archived: false } as Phase,
  fields: { title: titulo, description: descricao, type: tipo, origin: origem },
  allFields: [titulo, origem, tipo, modulo, prioridade, descricao, figma, rfc, anexo],
};

describe('planCreate com o Formulário Inicial do Backlog Produto', () => {
  const plan = planCreate(backlogProduto);

  it('passo 1: os 4 selects obrigatórios, na ordem do formulário', () => {
    assert.deepEqual(plan.selects.map((f) => f.name), ['Origem', 'Tipo', 'Módulo/Funcionalidade', 'Prioridade especial']);
  });

  it('modal 2: descrição e links (o título fica no modal 1)', () => {
    assert.equal(plan.titleField, titulo);
    assert.deepEqual(plan.modal.map((f) => f.name), ['Descrição', 'Link do figma (dev)', 'Link RFC']);
  });

  it('anexo fica de fora sem bloquear (é opcional)', () => {
    assert.deepEqual(plan.missingRequired, []);
    assert.deepEqual(plan.skipped.map((f) => f.name), ['Anexo']);
  });

  it('obrigatório de tipo não suportado aparece como pendência', () => {
    const p = planCreate({ ...backlogProduto, allFields: [...backlogProduto.allFields, field(9, 'Print', 'attachment', true)] });
    assert.deepEqual(p.missingRequired.map((f) => f.name), ['Print']);
  });

  it('mais de 4 selects: os excedentes vão para o modal, obrigatórios primeiro', () => {
    const extra = field(10, 'Ambiente', 'singleselect', true, ['Produção', 'Homologação']);
    const p = planCreate({ ...backlogProduto, allFields: [...backlogProduto.allFields, extra] });
    assert.equal(p.selects.length, 4);
    assert.deepEqual(p.modal.map((f) => f.name), ['Descrição', 'Ambiente', 'Link do figma (dev)', 'Link RFC']);
  });
});

describe('pré-seleção a partir do tópico', () => {
  it('tags do fórum e "Origem:" do modelo preenchem os selects', () => {
    const values = suggestSelects([origem, tipo, modulo, prioridade], ['Major', 'Regressão', 'N2'], { origin: 'suporte' });
    assert.deepEqual(values, { f1: ['Suporte'], f2: ['Regressão'], f4: ['Major'] });
  });

  it('"Atenção Especial" casa com a opção de mesmo nome', () => {
    assert.deepEqual(suggestSelects([prioridade], ['🩹 Atenção Especial'], {}), { f4: ['Atenção Especial'] });
  });
});

describe('modal aceito pelo Discord (bug de produção: COMPONENT_VALIDATION_FAILED)', () => {
  const email = field(9, 'E-mail do solicitante', 'email', true);
  const cliente = field(10, 'Qual cliente?', 'shorttext', false);
  const topic = {
    content: '**Cliente / Organização:** ACME Ltda\nfilial Curitiba\n**Origem:** Suporte\ncontato: joao.silva@acme.com.br',
    parsed: { client: 'ACME Ltda\nfilial Curitiba', origin: 'Suporte' },
    message: undefined,
  };

  it('cliente em várias linhas: usa só a primeira; e-mail vem do texto do tópico', () => {
    const values = suggestTexts({ description: descricao }, [descricao, email, cliente], topic);
    assert.deepEqual(values[cliente.fieldInfoId], ['ACME Ltda']);
    assert.deepEqual(values[email.fieldInfoId], ['joao.silva@acme.com.br']);
  });

  it('campo de uma linha nunca recebe quebra de linha', () => {
    type ModalJson = { components: { component: { style: number; value?: string } }[] };
    const modal1 = classifyModal('Título\ncom quebra', [], {}).toJSON() as unknown as ModalJson;
    const modal2 = cardModal([descricao, email, cliente, figma], {
      [cliente.fieldInfoId]: ['linha 1\nlinha 2\r\n  linha 3'],
      [descricao.fieldInfoId]: ['parágrafo 1\n\nparágrafo 2'],
    }).toJSON() as unknown as ModalJson;
    for (const { component } of [...modal1.components, ...modal2.components]) {
      if (component.style === 1 && component.value) assert.doesNotMatch(component.value, /\n/, component.value);
    }
    assert.equal(modal1.components[0]!.component.value, 'Título com quebra');
    const values = modal2.components.map((c) => c.component.value);
    assert.ok(values.includes('linha 1 linha 2 linha 3'));
    assert.ok(values.includes('parágrafo 1\n\nparágrafo 2'), 'parágrafo (longtext) mantém as quebras');
  });
});

describe('fluxo em dois modais (Backlog Produto)', () => {
  const plan = planCreate(backlogProduto);
  const muitos = { ...modulo, options: Array.from({ length: 25 }, (_, i) => `Módulo ${i} ${'x'.repeat(i * 3)}`) };

  it('modal 1: título + os 4 selects, com a pré-seleção marcada', () => {
    const json = classifyModal('Erro ao salvar', [origem, tipo, muitos, prioridade], { [prioridade.fieldInfoId]: ['Major'] }).toJSON() as unknown as {
      components: { component: { custom_id: string; options?: { label: string; default?: boolean }[] } }[];
    };
    assert.equal(json.components.length, 5, 'limite do Discord: 5 componentes por modal');
    const prio = json.components[4]!.component.options!;
    assert.deepEqual(prio.filter((o) => o.default).map((o) => o.label), ['Major']);
  });

  it('modal 2: até 5 campos (o Link RFC agora cabe)', () => {
    const p = planCreate({ ...backlogProduto, allFields: [...backlogProduto.allFields, field(11, 'Qual cliente?', 'shorttext', false), field(12, 'E-mail', 'email', true)] });
    assert.equal(p.modal.length, 5);
    assert.ok(cardModal(p.modal, {}).toJSON());
  });

  it('mensagem entre os passos só tem botões (nada de select para o Discord travar)', () => {
    const msg = draftMessage(plan.selects, { [origem.fieldInfoId]: ['Suporte'] }, 'classified');
    const rows = msg.components.map((r) => r.toJSON()) as unknown as { components: { type: number }[] }[];
    assert.ok(rows.every((r) => r.components.every((c) => c.type === 2)), 'só botões (type 2)');
    assert.match(msg.embeds[0]!.toJSON().description!, /\*\*Origem:\*\* Suporte/);
  });
});

describe('fieldKind e matchOption', () => {
  it('classifica os tipos da Goalfy', () => {
    assert.equal(fieldKind(prioridade), 'select');
    assert.equal(fieldKind(descricao), 'longtext');
    assert.equal(fieldKind(figma), 'text');
    assert.equal(fieldKind(anexo), 'unsupported');
    assert.equal(fieldKind(field(0, 'Muitos', 'singleselect', true, Array.from({ length: 30 }, (_, i) => `op ${i}`))), 'text');
  });

  it('tolera acento, caixa e travessão', () => {
    assert.equal(matchOption(prioridade, 'atencao especial'), 'Atenção Especial');
    assert.equal(matchOption(modulo, 'board/kanban'), 'Board/Kanban');
    assert.equal(matchOption(prioridade, 'Urgente'), undefined);
  });
});

describe('planMoveFields com as fases do Backlog Produto', () => {
  const mapaTestes = field(20, 'Mapa para Testes', 'longtext', true);
  const aprovado = field(21, 'Aprovado para liberar em produção?', 'singleselect', true, ['Sim', 'Não']);
  const motivo = field(22, 'Motivo do arquivamento', 'longtext', true);

  it('avançar de Desenvolvido sem o Mapa para Testes pede o campo', () => {
    const p = planMoveFields({ forward: true, currentRequired: [mapaTestes], filledInfoIds: new Set(), targetIsDone: false, targetRequired: [] });
    assert.deepEqual(p.leave, [mapaTestes]);
    assert.deepEqual(p.blocked, []);
  });

  it('com o Mapa já preenchido, move direto', () => {
    const p = planMoveFields({ forward: true, currentRequired: [mapaTestes], filledInfoIds: new Set(['f20']), targetIsDone: false, targetRequired: [] });
    assert.deepEqual([p.leave, p.done], [[], []]);
  });

  it('voltar de fase não exige os campos da fase atual', () => {
    const p = planMoveFields({ forward: false, currentRequired: [aprovado], filledInfoIds: new Set(), targetIsDone: false, targetRequired: [] });
    assert.deepEqual(p.leave, []);
  });

  it('Cancelado/Arquivado (fase final) pede o motivo', () => {
    const p = planMoveFields({ forward: true, currentRequired: [], filledInfoIds: new Set(), targetIsDone: true, targetRequired: [motivo] });
    assert.deepEqual(p.done, [motivo]);
  });

  it('obrigatório que o bot não sabe coletar bloqueia (vai para a Goalfy)', () => {
    const print = field(23, 'Evidência', 'attachment', true);
    const p = planMoveFields({ forward: true, currentRequired: [print], filledInfoIds: new Set(), targetIsDone: false, targetRequired: [] });
    assert.deepEqual(p.blocked, [print]);
  });
});
