/**
 * Plano de coleta usando o formulário REAL do board "Backlog Produto" (produção) e
 * as fases com formulário dele.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CreateForm } from '../src/goalfy/board.js';
import { fieldKind, matchOption, planCreate, planMoveFields } from '../src/goalfy/formPlan.js';
import type { FormField, Phase } from '../src/goalfy/types.js';
import { suggestSelects } from '../src/discord/triage.js';

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

  it('passo 2: descrição e links no modal (o título ocupa a 1ª vaga)', () => {
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
