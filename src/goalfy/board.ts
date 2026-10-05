import type { GoalfyConfig } from '../config.js';
import { logger } from '../logger.js';
import { CANCEL_PHASE_PATTERN, DONE_PHASE_PATTERN, FIELD_ALIASES, type LogicalField, normalize } from '../process.js';
import type { CardFilter, GoalfyClient } from './client.js';
import { RESPONSIBLE_FIELD_ID } from './formPlan.js';
import { type Card, type FormField, type Member, type Phase, toCardPage, toFormModel, toMembers, toPhaseFields, toPhases } from './types.js';

const CACHE_TTL_MS = 5 * 60_000;

export interface CreateForm {
  modelId: string;
  initialPhase: Phase;
  /** Campos com papel conhecido pelo bot, detectados pelo nome (título, descrição, link do Discord…). */
  fields: Partial<Record<LogicalField, FormField>>;
  /** Todos os campos do Formulário Inicial, na ordem da Goalfy, com `required`. */
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

/**
 * Tipos aceitos para campos que o bot preenche sozinho. Evita, por exemplo, gravar o nome
 * do Discord em "E-mail do solicitante" (o bot não conhece o e-mail de quem abriu o tópico).
 */
const ROLE_TYPES: Partial<Record<LogicalField, RegExp>> = {
  title: /text/,
  description: /text/,
  discordLink: /text|url|link/,
  requester: /^(shorttext|text|longtext)$/,
};

/** Metadados do board (fases e formulário), com cache em memória. */
export class BoardService {
  private phasesCache?: { at: number; value: Phase[] };
  private formCache?: { at: number; value: CreateForm };
  private formRefresh?: Promise<unknown>;
  private membersCache?: { at: number; value: Member[] };
  private modelCache = new Map<string, { at: number; value: FormField[] }>();

  constructor(
    private readonly client: GoalfyClient,
    private readonly config: GoalfyConfig & { GOALFY_BOARD_ID: string },
  ) {}

  get boardId() {
    return this.config.GOALFY_BOARD_ID;
  }

  private get appUrl() {
    return this.config.GOALFY_APP_URL.replace(/\/+$/, '');
  }

  /** Rota do front: /board/:boardId/:subRoute?/:editId? → abre o card sobre o board. */
  cardUrl(cardId: string) {
    return `${this.appUrl}/board/${this.boardId}/cards/${cardId}`;
  }

  boardUrl() {
    return `${this.appUrl}/board/${this.boardId}`;
  }

  invalidate() {
    this.phasesCache = undefined;
    this.formCache = undefined;
    this.modelCache.clear();
    this.membersCache = undefined;
  }

  /** Campos de um formulário (GET /models/{id}), com cache. */
  async modelFields(modelId: string): Promise<FormField[]> {
    const hit = this.modelCache.get(modelId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = toFormModel(await this.client.getModel(modelId))?.fields ?? [];
    this.modelCache.set(modelId, { at: Date.now(), value });
    return value;
  }

  /** Campos do formulário de uma fase (preenchidos enquanto o card está nela). */
  async phaseFields(phase: Phase): Promise<FormField[]> {
    return phase.modelId ? this.modelFields(phase.modelId) : [];
  }

  /** Membros do board (quem pode ser responsável), com cache. */
  async members(): Promise<Member[]> {
    if (this.membersCache && Date.now() - this.membersCache.at < CACHE_TTL_MS) return this.membersCache.value;
    const value = toMembers(await this.client.listMembers(this.boardId));
    this.membersCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Campo "Responsável" para o modal de criação: membros ativos do board (menos o próprio bot),
   * opcionalmente restritos a GOALFY_RESPONSIBLES. Rótulo = nome; nomes repetidos ganham o e-mail.
   * Devolve também o mapa rótulo → e-mail, que é o que vai para a API.
   */
  async responsibleField(): Promise<{ field: FormField; emailByLabel: Map<string, string> } | undefined> {
    const allowed = this.config.GOALFY_RESPONSIBLES.map((e) => e.toLowerCase());
    const eligible = (await this.members())
      .filter((m) => m.accepted && !m.isCurrentUser && m.email)
      .filter((m) => !allowed.length || allowed.includes(m.email!.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    if (!eligible.length) return undefined;

    const counts = new Map<string, number>();
    for (const m of eligible) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
    const emailByLabel = new Map<string, string>();
    for (const m of eligible.slice(0, 25)) {
      emailByLabel.set(counts.get(m.name)! > 1 ? `${m.name} (${m.email})` : m.name, m.email!);
    }
    return {
      emailByLabel,
      field: {
        fieldInfoId: RESPONSIBLE_FIELD_ID,
        name: 'Responsável (quem vai desenvolver)',
        type: 'singleselect',
        required: false,
        options: [...emailByLabel.keys()],
        index: Number.MAX_SAFE_INTEGER,
        helpText: 'Opcional: pode ser definido depois na Goalfy',
      },
    };
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
   * Fases em que o card pode nascer: a inicial (sempre, primeira da lista), as que têm
   * "permitir criar card direto" na Goalfy e as de GOALFY_CREATE_PHASES. Nunca fases finais.
   */
  async creatablePhases(): Promise<Phase[]> {
    const phases = await this.phases();
    const configured = this.config.GOALFY_CREATE_PHASES.map(normalize);
    return phases.filter(
      (p, i) =>
        i === 0 ||
        (!this.isDone(p) && (p.allowDirectCreation || configured.includes(normalize(p.title)) || this.config.GOALFY_CREATE_PHASES.includes(p.id))),
    );
  }

  /** Fase final de cancelamento/arquivamento (ex.: "Cancelado/Arquivado"). */
  isCancel(phase: Phase): boolean {
    return this.isDone(phase) && CANCEL_PHASE_PATTERN.test(phase.title);
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
  /**
   * Formulário de criação. Com cache vencido, devolve o cache na hora e atualiza em segundo plano:
   * o "Criar card" precisa abrir o modal em menos de 3s, então não pode esperar a Goalfy.
   */
  async createForm(): Promise<CreateForm> {
    if (this.formCache) {
      if (Date.now() - this.formCache.at >= CACHE_TTL_MS && !this.formRefresh) {
        this.formRefresh = this.loadCreateForm()
          .catch((e) => logger.warn('Não consegui atualizar o formulário de criação; seguindo com o cache', e))
          .finally(() => (this.formRefresh = undefined));
      }
      return this.formCache.value;
    }
    return this.loadCreateForm();
  }

  private async loadCreateForm(): Promise<CreateForm> {

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
    // /models traz o "obrigatório" de cada campo; /boards/{id}/fields não. Se falhar, segue sem ele.
    const allFields = await this.modelFields(modelId).catch((e) => {
      logger.warn(`Não consegui ler o formulário ${modelId}; usando /boards/{id}/fields`, e);
      return startForm?.fields ?? [];
    });

    const fields: CreateForm['fields'] = {};
    const used = new Set<string>();
    for (const key of Object.keys(FIELD_ALIASES) as LogicalField[]) {
      const envId = this.config[ENV_FIELD[key]] as string | undefined;
      const field = envId
        ? (allFields.find((f) => f.fieldInfoId === envId) ?? { fieldInfoId: envId, name: key, type: 'shorttext', required: false, options: [], index: 0 })
        : matchField(ROLE_TYPES[key] ? allFields.filter((f) => ROLE_TYPES[key]!.test(f.type)) : allFields, FIELD_ALIASES[key], used);
      if (field) {
        fields[key] = field;
        used.add(field.fieldInfoId);
      }
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
