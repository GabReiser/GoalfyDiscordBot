import { logger } from '../logger.js';
import { BOT_COMMENT_PREFIX, type LogicalField, normalize } from '../process.js';
import type { BoardService } from './board.js';
import type { FieldValue, GoalfyClient } from './client.js';
import { type Card, type FormField, type Phase, extractCardId, toCard } from './types.js';

/** Dados do card conforme a seção 12 do processo. */
export interface NewCardInput {
  title: string;
  description: string;
  expectedResult?: string;
  front: string;
  type: string;
  origin: string;
  client?: string;
  severity?: string;
  discordLink?: string;
  ticketLink?: string;
  requester: string;
}

/** Tipos da Goalfy cujo valor é uma lista (`checkbox` → string[]; `singleSelect` e textos → string). */
const MULTI_VALUE_TYPES = /^(checkbox|tag|responsible|attachment)$/i;

/**
 * Casa o valor com as opções de um campo de seleção, tolerando acento, caixa e pontuação
 * ("S1 — Crítico" ≈ "S1 - Critico") e, por último, só o primeiro termo ("S1").
 * Campos sem opções aceitam o valor como veio.
 */
function matchOption(field: FormField, value: string): string | undefined {
  if (!field.options.length) return value;
  const n = normalize(value);
  const first = (s: string) => s.split(' ')[0] ?? '';
  return (
    field.options.find((o) => normalize(o) === n) ??
    field.options.find((o) => normalize(o).startsWith(n) || n.startsWith(normalize(o))) ??
    field.options.find((o) => first(normalize(o)).length >= 2 && first(normalize(o)) === first(n))
  );
}

function fieldValue(field: FormField, value: string): FieldValue {
  return { fieldInfoId: field.fieldInfoId, value: MULTI_VALUE_TYPES.test(field.type) ? [value] : value };
}

const LABELS: Record<Exclude<LogicalField, 'title'>, string> = {
  description: 'Descrição',
  expectedResult: 'Resultado esperado',
  front: 'Frente',
  type: 'Tipo',
  origin: 'Origem',
  client: 'Cliente',
  severity: 'Severidade',
  discordLink: 'Tópico no Discord',
  ticketLink: 'Ticket N1',
  requester: 'Solicitante',
};

export class CardService {
  constructor(
    private readonly client: GoalfyClient,
    private readonly board: BoardService,
  ) {}

  async get(cardId: string): Promise<Card> {
    const card = toCard(await this.client.getCard(cardId));
    if (!card) throw new Error(`Resposta inesperada ao buscar o card ${cardId}.`);
    return card;
  }

  async create(input: NewCardInput): Promise<Card> {
    const form = await this.board.createForm();

    const fields: FieldValue[] = [];
    const stored = new Set<LogicalField>();
    const unmapped: string[] = [];
    for (const [key, value] of Object.entries(input) as [LogicalField, string | undefined][]) {
      if (!value || value === 'N/A') continue;
      const field = form.fields[key];
      const option = field && matchOption(field, value);
      if (field && option) {
        fields.push(fieldValue(field, option));
        stored.add(key);
      }
      else if (key !== 'title') unmapped.push(`**${LABELS[key]}:** ${value}`);
      if (field && !option) {
        logger.warn(`"${value}" não é uma opção do campo "${field.name}" (${field.options.join(', ')}); vai como comentário`);
      }
    }

    const raw = await this.client.createCard(form.modelId, fields);
    const id = extractCardId(raw);
    if (!id) {
      logger.error('Card criado, mas não encontrei o ID na resposta', raw);
      throw new Error('A Goalfy criou o card mas não retornou o ID.');
    }

    // Se o tipo não ficou gravado num campo, ele vai no título para continuar visível no board.
    const title = stored.has('type') ? input.title : `[${input.type}] ${input.title}`;
    await this.client.setCardTitle(id, title).catch((e) => logger.warn(`Não consegui definir o título do card ${id}`, e));

    // O que não coube em campos do formulário vai como comentário, para nada se perder.
    const summary = [`Card aberto via Discord por ${input.requester}.`, ...unmapped].join('\n');
    await this.comment(id, summary).catch((e) => logger.warn(`Não consegui comentar no card ${id}`, e));

    return (
      (await this.get(id).catch(() => undefined)) ?? {
        id,
        title,
        responsibles: [],
        tags: [],
        phaseId: form.initialPhase.id,
        phaseName: form.initialPhase.title,
      }
    );
  }

  /** Move o card; fases finais usam o endpoint específico de conclusão. */
  async move(cardId: string, phase: Phase): Promise<void> {
    if (this.board.isDone(phase)) {
      try {
        await this.client.moveCardToDonePhase(cardId, { modelId: phase.modelId, phaseId: phase.id, fields: [] });
        return;
      } catch (e) {
        logger.warn(`moveToDonePhase falhou para o card ${cardId}, tentando moveTo`, e);
      }
    }
    await this.client.moveCard(cardId, phase.id);
  }

  comment(cardId: string, text: string) {
    return this.client.addComment(cardId, `${BOT_COMMENT_PREFIX} ${text}`);
  }
}
