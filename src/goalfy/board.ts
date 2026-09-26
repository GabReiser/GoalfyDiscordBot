import type { GoalfyConfig } from '../config.js';
import { logger } from '../logger.js';
import { DONE_PHASE_PATTERN, FIELD_ALIASES, type LogicalField, normalize } from '../process.js';
import type { CardFilter, GoalfyClient } from './client.js';
import { type Card, type FormField, type Phase, toCardPage, toPhaseFields, toPhases } from './types.js';

const CACHE_TTL_MS = 5 * 60_000;

export interface CreateForm {
  modelId: string;
  initialPhase: Phase;
  fields: Partial<Record<LogicalField, FormField>>;
  allFields: FormField[];
}

const ENV_FIELD: Record<LogicalField, keyof GoalfyConfig> = {
  title: 'GOALFY_FIELD_TITLE',
  description: 'GOALFY_FIELD_DESCRIPTION',
  expectedResult: 'GOALFY_FIELD_EXPECTED_RESULT',
  front: 'GOALFY_FIELD_FRONT',
  type: 'GOALFY_FIELD_TYPE',
  origin: 'GOALFY_FIELD_ORIGIN',
  client: 'GOALFY_FIELD_CLIENT',
  severity: 'GOALFY_FIELD_SEVERITY',
  discordLink: 'GOALFY_FIELD_DISCORD_LINK',
  ticketLink: 'GOALFY_FIELD_TICKET_LINK',
  requester: 'GOALFY_FIELD_REQUESTER',
};

/** Metadados do board (fases e formulário), com cache em memória. */
export class BoardService {
  private phasesCache?: { at: number; value: Phase[] };
  private formCache?: { at: number; value: CreateForm };

  constructor(
    private readonly client: GoalfyClient,
    private readonly config: GoalfyConfig & { GOALFY_BOARD_ID: string },
  ) {}

  get boardId() {
    return this.config.GOALFY_BOARD_ID;
  }

  cardUrl(cardId: string) {
    return `${this.config.GOALFY_APP_URL}/card/${cardId}`;
  }

  boardUrl() {
    return `${this.config.GOALFY_APP_URL}/boards/${this.boardId}`;
  }

  invalidate() {
    this.phasesCache = undefined;
    this.formCache = undefined;
  }

  async phases(): Promise<Phase[]> {
    if (this.phasesCache && Date.now() - this.phasesCache.at < CACHE_TTL_MS) return this.phasesCache.value;
    const value = toPhases(await this.client.listPhases(this.boardId));
    this.phasesCache = { at: Date.now(), value };
    return value;
  }

  async phase(idOrName: string): Promise<Phase | undefined> {
    const phases = await this.phases();
    const n = normalize(idOrName);
    return phases.find((p) => p.id === idOrName) ?? phases.find((p) => normalize(p.title) === n);
  }

  /** Fase final: GOALFY_DONE_PHASES > flag `done` da Goalfy > nome da fase. */
  isDone(phase: Phase): boolean {
    const configured = this.config.GOALFY_DONE_PHASES;
    if (configured.length) {
      return configured.some((c) => c === phase.id || normalize(c) === normalize(phase.title));
    }
    return phase.done ?? DONE_PHASE_PATTERN.test(phase.title);
  }

  /**
   * Busca paginada de cards do board. `page` começa em 1 aqui (mais natural para a UI);
   * a conversão para o índice 0-based da API acontece só neste ponto.
   * As listagens da API trazem apenas `phaseId`, então o nome da fase é preenchido pelo cache.
   */
  async searchCards(opts: { page?: number; limit: number; search?: string } & Omit<CardFilter, 'offset' | 'limit' | 'search'>) {
    const { page = 1, ...filter } = opts;
    const { cards, total } = toCardPage(await this.client.filterCards(this.boardId, { ...filter, offset: page - 1 }));
    return { cards: await this.withPhaseNames(cards), total };
  }

  async withPhaseNames(cards: Card[]): Promise<Card[]> {
    const byId = new Map((await this.phases()).map((p) => [p.id, p.title]));
    return cards.map((c) => (c.phaseName || !c.phaseId ? c : { ...c, phaseName: byId.get(c.phaseId) }));
  }

  /** Resolve a fase de um card, venha ela por ID ou só pelo nome. */
  async phaseOf(card: Card): Promise<Phase | undefined> {
    if (card.phaseId) {
      const byId = await this.phase(card.phaseId);
      if (byId) return byId;
    }
    return card.phaseName ? this.phase(card.phaseName) : undefined;
  }

  /** Formulário de criação: modelId + campos detectados (env tem prioridade sobre o nome). */
  async createForm(): Promise<CreateForm> {
    if (this.formCache && Date.now() - this.formCache.at < CACHE_TTL_MS) return this.formCache.value;

    const phases = await this.phases();
    const initialPhase = phases[0];
    if (!initialPhase) throw new Error(`O board ${this.boardId} não tem fases.`);

    // GET /boards/{id}/fields → [ {id: modelId, name: "Formulário Inicial", fields}, {id: phaseId, name: fase, fields}, … ]
    // O card nasce pelo Formulário Inicial do board, não pelo formulário da primeira fase.
    const groups = toPhaseFields(await this.client.getBoardFields(this.boardId));
    const phaseIds = new Set(phases.map((p) => p.id));
    const startForm =
      (this.config.GOALFY_MODEL_ID && groups.find((g) => g.phaseId === this.config.GOALFY_MODEL_ID)) ||
      groups.find((g) => g.phaseName && normalize(g.phaseName) === 'formulario inicial') ||
      groups.find((g) => g.phaseId && !phaseIds.has(g.phaseId));

    const modelId = this.config.GOALFY_MODEL_ID ?? startForm?.phaseId;
    if (!modelId) {
      throw new Error('Não encontrei o Formulário Inicial do board. Defina GOALFY_MODEL_ID no .env (veja `npm run discover`).');
    }
    const allFields = startForm?.fields ?? [];

    const fields: CreateForm['fields'] = {};
    const used = new Set<string>();
    for (const key of Object.keys(FIELD_ALIASES) as LogicalField[]) {
      const envId = this.config[ENV_FIELD[key]] as string | undefined;
      const field = envId
        ? (allFields.find((f) => f.fieldInfoId === envId) ?? { fieldInfoId: envId, name: key, type: 'text', required: false, options: [] })
        : matchField(allFields, FIELD_ALIASES[key], used);
      if (field) {
        fields[key] = field;
        used.add(field.fieldInfoId);
      }
    }

    const missing = allFields.filter((f) => f.required && !used.has(f.fieldInfoId));
    if (missing.length) {
      logger.warn(`Campos obrigatórios sem mapeamento: ${missing.map((f) => `${f.name} (${f.fieldInfoId})`).join(', ')}`);
    }

    const value = { modelId, initialPhase, fields, allFields };
    this.formCache = { at: Date.now(), value };
    return value;
  }
}

function matchField(fields: FormField[], aliases: readonly string[], used: Set<string>): FormField | undefined {
  const free = fields.filter((f) => !used.has(f.fieldInfoId));
  for (const alias of aliases) {
    const exact = free.find((f) => normalize(f.name) === alias);
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const partial = free.find((f) => normalize(f.name).includes(alias));
    if (partial) return partial;
  }
  return undefined;
}
