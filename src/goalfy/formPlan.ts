/**
 * Decide COMO coletar no Discord cada campo de um formulário da Goalfy.
 *
 * O bot não tem campos fixos: ele lê o formulário real (Formulário Inicial do board ou o
 * formulário de uma fase) e distribui os campos entre os componentes do Discord, que têm limites:
 *  - uma mensagem comporta 5 linhas de componentes → até 4 selects + 1 linha de botões;
 *  - um modal comporta 5 componentes;
 *  - um select tem no máximo 25 opções.
 *
 * Lógica pura (sem Discord nem HTTP) para ser fácil de testar.
 */
import { normalize } from '../process.js';
import type { CreateForm } from './board.js';
import type { FieldValue } from './client.js';
import type { FormField } from './types.js';

export const MAX_SELECTS_PER_MESSAGE = 4;
export const MAX_MODAL_INPUTS = 5;
export const MAX_SELECT_OPTIONS = 25;

export type FieldKind = 'select' | 'text' | 'longtext' | 'unsupported';

/** Tipos que o bot não sabe preencher (anexos, responsáveis, vínculos, fórmulas…). */
const UNSUPPORTED = /attachment|responsible|tag|database|connected|formula|sequencer|fixed|dynamic|message|password|json|keyvalue/;
const LONG_TEXT = /longtext|textarea|richtext/;
const TEXT = /text|email|phone|number|currency|document|url|link|cpf|cnpj|time|date|expiration/;

export function fieldKind(f: FormField): FieldKind {
  if (UNSUPPORTED.test(f.type)) return 'unsupported';
  if (f.options.length > 0 && f.options.length <= MAX_SELECT_OPTIONS) return 'select';
  if (LONG_TEXT.test(f.type)) return 'longtext';
  // Seleção com opções demais vira texto livre, casado depois com as opções (matchOption).
  if (TEXT.test(f.type) || f.options.length > MAX_SELECT_OPTIONS) return 'text';
  return 'unsupported';
}

export const isMulti = (f: FormField) => /checkbox|multi/.test(f.type);

/** Tipos da Goalfy cujo valor é lista (`checkbox` → string[]; `singleSelect` e textos → string). */
const MULTI_VALUE_TYPES = /^(checkbox|tag|responsible|attachment)$/i;

/**
 * Casa um valor digitado/sugerido com as opções do campo, tolerando acento, caixa e
 * pontuação ("S1 — Crítico" ≈ "S1 - Critico") e, por último, só o primeiro termo ("S1").
 * Campo sem opções aceita o valor como veio.
 */
export function matchOption(field: FormField, value: string): string | undefined {
  if (!field.options.length) return value;
  const n = normalize(value);
  if (!n) return undefined;
  const first = (s: string) => s.split(' ')[0] ?? '';
  return (
    field.options.find((o) => normalize(o) === n) ??
    field.options.find((o) => normalize(o).startsWith(n) || n.startsWith(normalize(o))) ??
    field.options.find((o) => first(normalize(o)).length >= 2 && first(normalize(o)) === first(n))
  );
}

/** Monta o valor no formato que a API espera para o tipo do campo. */
export function toFieldValue(field: FormField, values: string[]): FieldValue {
  return {
    fieldInfoId: field.fieldInfoId,
    value: MULTI_VALUE_TYPES.test(field.type) ? values : (values[0] ?? ''),
  };
}

const byRequiredThenIndex = (a: FormField, b: FormField) => Number(b.required) - Number(a.required) || a.index - b.index;

// ── Criação de card ─────────────────────────────────────────────────────────

export interface CreatePlan {
  /** Campo "título" do formulário (se houver); o título do card é sempre pedido no modal. */
  titleField?: FormField;
  /** Modal 1: selects (até 4; o título ocupa a 5ª vaga). */
  selects: FormField[];
  /** Modal 2: campos de texto (e selects que não couberam no modal 1), até 5. */
  modal: FormField[];
  /** Preenchidos pelo bot, sem perguntar (link do tópico, solicitante). */
  auto: FormField[];
  /** Obrigatórios que o bot não consegue coletar: a criação provavelmente vai falhar. */
  missingRequired: FormField[];
  /** Opcionais que ficaram de fora por limite ou tipo (preencha na Goalfy, se precisar). */
  skipped: FormField[];
}

export function planCreate(form: CreateForm): CreatePlan {
  const auto = [form.fields.discordLink, form.fields.requester].filter((f): f is FormField => !!f);
  const titleField = form.fields.title;
  const handled = new Set([...auto, ...(titleField ? [titleField] : [])].map((f) => f.fieldInfoId));
  const rest = form.allFields.filter((f) => !handled.has(f.fieldInfoId));

  const allSelects = rest.filter((f) => fieldKind(f) === 'select').sort(byRequiredThenIndex);
  const selects = allSelects.slice(0, MAX_SELECTS_PER_MESSAGE);
  const overflowSelects = allSelects.slice(MAX_SELECTS_PER_MESSAGE);
  const texts = rest.filter((f) => fieldKind(f) === 'text' || fieldKind(f) === 'longtext');

  // Ordem de prioridade para as 5 vagas do modal 2 (o título fica no modal 1).
  const description = form.fields.description && texts.includes(form.fields.description) ? [form.fields.description] : [];
  const candidates = [
    ...description,
    ...texts.filter((f) => f.required && !description.includes(f)),
    ...overflowSelects.filter((f) => f.required),
    ...texts.filter((f) => !f.required && !description.includes(f)),
    ...overflowSelects.filter((f) => !f.required),
  ];
  const modal = [...new Set(candidates)].slice(0, MAX_MODAL_INPUTS);

  const collected = new Set([...handled, ...selects, ...modal].map((f) => (typeof f === 'string' ? f : f.fieldInfoId)));
  const left = rest.filter((f) => !collected.has(f.fieldInfoId));
  return {
    titleField,
    selects,
    modal,
    auto,
    missingRequired: left.filter((f) => f.required),
    skipped: left.filter((f) => !f.required),
  };
}

// ── Movimentação ────────────────────────────────────────────────────────────

export interface MoveFieldsPlan {
  /** Obrigatórios vazios da fase atual (preencher antes de avançar). */
  leave: FormField[];
  /** Obrigatórios da fase final de destino (enviados no moveToDonePhase). */
  done: FormField[];
  /** Obrigatórios que o bot não consegue coletar (tipo não suportado ou mais de 5). */
  blocked: FormField[];
}

/**
 * Campos a preencher para mover um card:
 *  - ao AVANÇAR, os obrigatórios da fase atual precisam estar preenchidos (regra do board);
 *  - ao entrar numa fase FINAL, os obrigatórios dela vão junto no moveToDonePhase.
 */
export function planMoveFields(opts: {
  forward: boolean;
  currentRequired: FormField[];
  filledInfoIds: Set<string>;
  targetIsDone: boolean;
  targetRequired: FormField[];
}): MoveFieldsPlan {
  const leave = opts.forward ? opts.currentRequired.filter((f) => !opts.filledInfoIds.has(f.fieldInfoId)) : [];
  const done = opts.targetIsDone ? opts.targetRequired : [];
  const all = [...leave, ...done];
  const unsupported = all.filter((f) => fieldKind(f) === 'unsupported');
  const blocked = unsupported.length || all.length > MAX_MODAL_INPUTS ? all : [];
  return { leave, done, blocked };
}
