import { logger } from '../logger.js';
import { BOT_COMMENT_PREFIX } from '../process.js';
import type { BoardService } from './board.js';
import type { FieldValue, GoalfyClient } from './client.js';
import { matchOption, toFieldValue } from './formPlan.js';
import { type Card, extractCardId, type FormField, type Phase, toCard } from './types.js';

/** Valores coletados no Discord, por fieldInfoId. */
export type FieldInputs = Record<string, string | string[]>;

export interface NewCardInput {
  title: string;
  /** Valores dos campos do Formulário Inicial (selects e textos coletados no Discord). */
  values: FieldInputs;
  requester: string;
  discordUrl?: string;
}

export class InvalidFieldValuesError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'InvalidFieldValuesError';
  }
}

/**
 * Converte os valores coletados para o formato da API, casando seleções com as opções do campo.
 * Valor fora das opções em campo obrigatório vira erro (o usuário corrige); em opcional, é ignorado.
 */
export function buildFieldValues(fields: FormField[], values: FieldInputs): { fields: FieldValue[]; problems: string[] } {
  const out: FieldValue[] = [];
  const problems: string[] = [];
  for (const field of fields) {
    const raw = values[field.fieldInfoId];
    const list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((v) => v.trim()).filter(Boolean);
    if (!list.length) {
      if (field.required) problems.push(`"${field.name}" é obrigatório.`);
      continue;
    }
    const matched = list.map((v) => matchOption(field, v));
    if (matched.some((m) => m === undefined)) {
      const opts = `${field.options.slice(0, 15).join(', ')}${field.options.length > 15 ? '…' : ''}`;
      const msg = `"${list.join(', ')}" não é uma opção de "${field.name}". Opções: ${opts}`;
      if (field.required) problems.push(msg);
      else logger.warn(msg);
      continue;
    }
    out.push(toFieldValue(field, matched as string[]));
  }
  return { fields: out, problems };
}

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
    const values: FieldInputs = { ...input.values };
    if (form.fields.title) values[form.fields.title.fieldInfoId] = input.title;
    if (form.fields.discordLink && input.discordUrl) values[form.fields.discordLink.fieldInfoId] = input.discordUrl;
    if (form.fields.requester) values[form.fields.requester.fieldInfoId] = input.requester;

    const { fields, problems } = buildFieldValues(form.allFields, values);
    if (problems.length) throw new InvalidFieldValuesError(problems);

    const raw = await this.client.createCard(form.modelId, fields);
    const id = extractCardId(raw);
    if (!id) {
      logger.error('Card criado, mas não encontrei o ID na resposta', raw);
      throw new Error('A Goalfy criou o card mas não retornou o ID.');
    }

    await this.client.setCardTitle(id, input.title).catch((e) => logger.warn(`Não consegui definir o título do card ${id}`, e));

    // Rastreabilidade: quem abriu e onde está a conversa, se o formulário não tiver campo para isso.
    const lines = [`Card aberto via Discord por ${input.requester}.`];
    if (input.discordUrl && !form.fields.discordLink) lines.push(`Tópico: ${input.discordUrl}`);
    await this.comment(id, lines.join('\n')).catch((e) => logger.warn(`Não consegui comentar no card ${id}`, e));

    return (
      (await this.get(id).catch(() => undefined)) ?? {
        id,
        title: input.title,
        responsibles: [],
        tags: [],
        phaseId: form.initialPhase.id,
        phaseName: form.initialPhase.title,
        phaseForms: [],
      }
    );
  }

  /**
   * Grava campos do formulário da fase atual do card (ex.: "Mapa para Testes" antes de avançar).
   * Campo que já existe no formulário é atualizado; senão é criado.
   */
  async fillPhaseFields(card: Card, phaseId: string, fields: FormField[], values: FieldInputs) {
    const history = card.phaseForms.find((h) => h.phaseId === phaseId);
    if (!history?.formId) throw new Error('Não encontrei o formulário da fase atual deste card na Goalfy.');
    const built = buildFieldValues(fields, values);
    if (built.problems.length) throw new InvalidFieldValuesError(built.problems);

    for (const fv of built.fields) {
      const existing = history.fields.find((f) => f.infoId === fv.fieldInfoId && f.id);
      const value = Array.isArray(fv.value) ? JSON.stringify(fv.value) : (fv.value ?? '');
      if (existing?.id) await this.client.updateCardField(existing.id, value);
      else await this.client.fillCardField(history.formId, card.id, fv.fieldInfoId, value);
    }
  }

  /** Move o card; fase final usa o endpoint de conclusão, levando os campos obrigatórios dela. */
  async move(cardId: string, phase: Phase, doneValues?: { fields: FormField[]; values: FieldInputs }): Promise<void> {
    if (this.board.isDone(phase)) {
      let fields: FieldValue[] = [];
      if (doneValues) {
        const built = buildFieldValues(doneValues.fields, doneValues.values);
        if (built.problems.length) throw new InvalidFieldValuesError(built.problems);
        fields = built.fields;
      }
      try {
        await this.client.moveCardToDonePhase(cardId, { modelId: phase.modelId, phaseId: phase.id, fields });
        return;
      } catch (e) {
        if (fields.length) throw e; // com campos, cair no moveTo perderia os valores
        logger.warn(`moveToDonePhase falhou para o card ${cardId}, tentando moveTo`, e);
      }
    }
    await this.client.moveCard(cardId, phase.id);
  }

  comment(cardId: string, text: string) {
    return this.client.addComment(cardId, `${BOT_COMMENT_PREFIX} ${text}`);
  }
}
