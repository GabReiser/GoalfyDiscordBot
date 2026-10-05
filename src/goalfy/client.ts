import { logger } from '../logger.js';

export class GoalfyError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'GoalfyError';
  }

  /** Mensagem amigável para mostrar no Discord. */
  get friendly(): string {
    switch (this.status) {
      case 400:
        return 'A Goalfy recusou os dados enviados (400). Verifique os campos obrigatórios do formulário.';
      case 401:
        return 'Token da Goalfy inválido ou expirado (401).';
      case 403:
        return 'O token da Goalfy não tem permissão para essa ação (403).';
      case 404:
        return 'Não encontrado na Goalfy (404). Confira o ID informado.';
      default:
        return `Erro na API da Goalfy (${this.status}).`;
    }
  }
}

export interface FieldValue {
  fieldInfoId: string;
  value: string | string[] | null;
}

export interface CardFilter {
  /** Sem limite, a API devolve até 25.000 cards. */
  limit?: number;
  /**
   * Índice da página, **começando em 0** (vira `Page.of(offset, limit)` no backend).
   * A documentação pública diz "começa em 1", mas isso pula a primeira página.
   */
  offset?: number;
  search?: string;
  startCreatedAt?: string;
  endCreatedAt?: string;
  startDueDate?: string;
  endDueDate?: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const IDEMPOTENT: ReadonlySet<Method> = new Set(['GET', 'PUT', 'DELETE']);
const MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cliente da REST API da Goalfy.
 * Docs: https://goalfy-rest-api.readme.io/reference/iniciando-com-a-rest-api-da-goalfy
 *
 * As respostas são devolvidas "cruas" (unknown); a normalização fica em ./types.ts,
 * porque os exemplos da documentação não são um schema garantido.
 */
export class GoalfyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T = unknown>(method: Method, path: string, body?: unknown, attempt = 0): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Token ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    // 429 é sempre seguro repetir; 5xx só em métodos idempotentes (evita card duplicado).
    const retryable = res.status === 429 || (res.status >= 500 && IDEMPOTENT.has(method));
    if (retryable && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt + Math.random() * 250;
      logger.warn(`Goalfy ${method} ${path} → ${res.status}, tentando de novo em ${Math.round(delay)}ms`);
      await sleep(delay);
      return this.request<T>(method, path, body, attempt + 1);
    }

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      logger.warn(`Goalfy ${method} ${path} → ${res.status}`, data);
      throw new GoalfyError(res.status, data, `Goalfy ${method} ${path} → ${res.status}`);
    }
    logger.debug(`Goalfy ${method} ${path} → ${res.status}`);
    return data as T;
  }

  // ── Boards ────────────────────────────────────────────────────────────────
  listBoards() {
    return this.request('GET', '/boards');
  }
  getBoard(boardId: string) {
    return this.request('GET', `/boards/${enc(boardId)}`);
  }
  searchBoards(query: string) {
    return this.request('GET', `/boards/search?query=${encodeURIComponent(query)}`);
  }
  /**
   * Formulários do board: o 1º item é o "Formulário Inicial" (id = modelId de criação de cards),
   * os demais são os formulários de cada fase (id = phaseId).
   * Obs.: a documentação pública indica `/{boardId}/fields`; a rota real fica em `/boards`.
   */
  getBoardFields(boardId: string) {
    return this.request('GET', `/boards/${enc(boardId)}/fields`);
  }
  listBoardActivities(boardId: string, limit = 50, offset = 0) {
    return this.request('GET', `/boards/${enc(boardId)}/activities?limit=${limit}&offset=${offset}`);
  }

  // ── Formulários ───────────────────────────────────────────────────────────
  /** Formulário completo, com `required`, `helpText` e opções (é o que o front usa). */
  getModel(modelId: string) {
    return this.request('GET', `/models/${enc(modelId)}`);
  }

  // ── Fases ─────────────────────────────────────────────────────────────────
  listPhases(boardId: string) {
    return this.request('GET', `/phases/board/${enc(boardId)}`);
  }
  getPhase(phaseId: string) {
    return this.request('GET', `/phases/${enc(phaseId)}`);
  }

  // ── Cards ─────────────────────────────────────────────────────────────────
  getCard(cardId: string) {
    return this.request('GET', `/cards/${enc(cardId)}`);
  }
  listCardsByBoard(boardId: string) {
    return this.request('GET', `/cards/board/${enc(boardId)}`);
  }
  listCardsByPhase(phaseId: string) {
    return this.request('GET', `/cards/phase/${enc(phaseId)}`);
  }
  filterCards(boardId: string, filter: CardFilter = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const q = qs.toString();
    return this.request('GET', `/cards/board/${enc(boardId)}/filter${q ? `?${q}` : ''}`);
  }
  /** Cria o card na fase inicial do fluxo do formulário `modelId`. */
  /** Sem `phaseId`, o card nasce na fase inicial do board; com ele, direto na fase informada. */
  createCard(modelId: string, fields: FieldValue[], phaseId?: string) {
    return this.request('POST', '/cards/form/', { modelId, fields, ...(phaseId ? { phaseId } : {}) });
  }
  setCardTitle(cardId: string, title: string) {
    return this.request('PUT', `/cards/${enc(cardId)}`, { title });
  }
  /** Preenche um campo do card pela primeira vez. */
  fillCardField(formId: string, cardId: string, fieldInfoId: string, value: string) {
    return this.request('POST', `/forms/${enc(formId)}/field/`, { cardId, fieldInfoId, value });
  }
  /** Atualiza um campo já preenchido (id do valor do campo no card). */
  updateCardField(fieldId: string, value: string) {
    return this.request('PUT', `/forms/field/${enc(fieldId)}`, { value });
  }
  moveCard(cardId: string, phaseId: string) {
    return this.request('PUT', `/cards/moveTo/${enc(cardId)}`, { phaseId });
  }
  moveCardToDonePhase(cardId: string, payload: { modelId?: string; phaseId: string; fields: FieldValue[] }) {
    return this.request('POST', `/cards/moveToDonePhase/${enc(cardId)}`, payload);
  }
  deleteCard(cardId: string) {
    return this.request('DELETE', `/cards/${enc(cardId)}`);
  }
  addTag(cardId: string, tagId: string) {
    return this.request('POST', `/cards/${enc(cardId)}/addTag/${enc(tagId)}`);
  }

  // ── Webhooks (não documentados publicamente) ─────────────────────────────
  /** Assina um evento do board; a Goalfy fará POST em `hookUrl` a cada ocorrência. */
  subscribeBoardHook(boardId: string, event: 'MOVE_CARD_TO' | 'CREATE_CARD' | 'UPDATE_CARD', hookUrl: string) {
    return this.request('POST', `/external/v1/boards/${enc(boardId)}/hook`, { event, hookUrl });
  }
  deleteBoardHook(boardId: string, hookId: string) {
    return this.request('DELETE', `/external/v1/boards/${enc(boardId)}/hook/${enc(hookId)}`);
  }

  // ── Membros e responsáveis ────────────────────────────────────────────────
  /** Membros de um contexto (board): `{ members: [{ id, name, email, role, status, isCurrentUser }], total }`. */
  listMembers(contextId: string) {
    return this.request('GET', `/members/${enc(contextId)}`);
  }
  /**
   * Adiciona responsáveis ao card. `value`: IDs, e-mails ou usernames separados por vírgula;
   * só entram membros do board (a API ignora quem não for).
   */
  addResponsible(cardId: string, value: string) {
    return this.request('POST', `/external/v1/cards/${enc(cardId)}/addResponsible`, { value });
  }

  // ── Comentários ───────────────────────────────────────────────────────────
  listComments(cardId: string) {
    return this.request('GET', `/cards/${enc(cardId)}/comments`);
  }
  addComment(cardId: string, body: string) {
    return this.request('POST', `/external/v1/cards/${enc(cardId)}/comments`, { body });
  }
}

const enc = encodeURIComponent;
