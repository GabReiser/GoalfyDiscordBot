/**
 * Normalizadores das respostas da Goalfy.
 *
 * A documentação mostra exemplos com formatos diferentes para o mesmo recurso
 * (ex.: card com `phase` em um endpoint e `phaseId` em outro), então cada função
 * aceita as variações conhecidas e ignora o resto.
 */

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

function pick(obj: Raw, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(obj[k]);
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/** Extrai uma lista de um retorno que pode ser `[...]`, `{cards: [...]}`, `{content: [...]}`, etc. */
export function unwrapList(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isObj(raw)) {
    for (const k of [...keys, 'data', 'content', 'items', 'results']) {
      const v = raw[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function personName(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (isObj(v)) {
    const inner = isObj(v.user) ? v.user : v;
    return pick(inner, 'name', 'fullName', 'displayName', 'username', 'email');
  }
  return undefined;
}

// ── Fases ───────────────────────────────────────────────────────────────────

export interface Phase {
  id: string;
  title: string;
  modelId?: string;
  index: number;
  archived: boolean;
  /** Flag "fase de conclusão" do board (`done` em GET /phases/board/{id}). */
  done?: boolean;
  description?: string;
}

export function toPhase(raw: unknown): Phase | undefined {
  if (!isObj(raw)) return undefined;
  const id = pick(raw, 'id', 'phaseId');
  if (!id) return undefined;
  return {
    id,
    title: pick(raw, 'title', 'name', 'phaseName') ?? `Fase ${id}`,
    modelId: pick(raw, 'modelId', 'formId'),
    index: typeof raw.index === 'number' ? raw.index : Number(raw.index ?? 0),
    archived: raw.archived === true,
    done: typeof raw.done === 'boolean' ? raw.done : undefined,
    description: pick(raw, 'description'),
  };
}

export function toPhases(raw: unknown): Phase[] {
  return unwrapList(raw, 'phases')
    .map(toPhase)
    .filter((p): p is Phase => !!p && !p.archived)
    .sort((a, b) => a.index - b.index);
}

// ── Campos ──────────────────────────────────────────────────────────────────

export interface FormField {
  fieldInfoId: string;
  name: string;
  type: string;
  required: boolean;
  options: string[];
}

export interface PhaseFields {
  phaseId?: string;
  phaseName?: string;
  fields: FormField[];
}

function toField(raw: unknown): FormField | undefined {
  if (!isObj(raw)) return undefined;
  const fieldInfoId = pick(raw, 'fieldInfoId', 'id');
  if (!fieldInfoId) return undefined;
  const rawOptions = unwrapList(raw.options ?? raw.choices ?? raw.values);
  return {
    fieldInfoId,
    name: pick(raw, 'name', 'label', 'title') ?? fieldInfoId,
    type: (pick(raw, 'type', 'fieldType') ?? 'text').toLowerCase(),
    required: raw.required === true || raw.mandatory === true,
    options: rawOptions.map((o) => (isObj(o) ? pick(o, 'label', 'name', 'value', 'title') : str(o))).filter(
      (o): o is string => !!o,
    ),
  };
}

export function toPhaseFields(raw: unknown): PhaseFields[] {
  return unwrapList(raw, 'phases').flatMap((g) => {
    if (!isObj(g)) return [];
    return [
      {
        phaseId: pick(g, 'phaseId', 'id'),
        phaseName: pick(g, 'phaseName', 'title', 'name'),
        fields: unwrapList(g.fields).map(toField).filter((f): f is FormField => !!f),
      },
    ];
  });
}

// ── Cards ───────────────────────────────────────────────────────────────────

export interface Card {
  id: string;
  title: string;
  phaseId?: string;
  phaseName?: string;
  formId?: string;
  responsibles: string[];
  tags: string[];
  dueDate?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function toCard(raw: unknown): Card | undefined {
  if (!isObj(raw)) return undefined;
  const src = isObj(raw.card) ? raw.card : raw;
  const id = pick(src, 'id', 'cardId');
  if (!id) return undefined;

  const phaseObj = isObj(src.phase) ? src.phase : undefined;
  const responsibles = [
    ...unwrapList(src.responsibles).map(personName),
    personName(src.responsible),
  ].filter((n): n is string => !!n);

  return {
    id,
    title: pick(src, 'title', 'name') ?? `Card ${id}`,
    phaseId: pick(src, 'phaseId') ?? (phaseObj && pick(phaseObj, 'id')),
    phaseName: phaseObj ? pick(phaseObj, 'title', 'name') : pick(src, 'phase', 'phaseName', 'phaseTitle'),
    formId: pick(src, 'formId', 'modelId'),
    responsibles: [...new Set(responsibles)],
    tags: unwrapList(src.tags)
      .map((t) => (isObj(t) ? pick(t, 'text', 'name', 'title', 'label') : str(t)))
      .filter((t): t is string => !!t),
    dueDate: pick(src, 'dueDate'),
    createdAt: pick(src, 'createdAt'),
    updatedAt: pick(src, 'updatedAt'),
  };
}

export function toCards(raw: unknown): Card[] {
  return unwrapList(raw, 'cards')
    .map(toCard)
    .filter((c): c is Card => !!c);
}

/** Retorno do filtro de cards: `{ cards: [...], cardsCount: <total> }`. */
export function toCardPage(raw: unknown): { cards: Card[]; total?: number } {
  const total = isObj(raw) && typeof raw.cardsCount === 'number' ? raw.cardsCount : undefined;
  return { cards: toCards(raw), total };
}

/**
 * A API serializa datas como `yyyy-MM-ddTHH:mm:ss.SSS` em UTC, sem sufixo de fuso.
 * `new Date()` leria isso como horário local, então o "Z" é acrescentado quando falta.
 */
export function parseApiDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const iso = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// ── Comentários ─────────────────────────────────────────────────────────────

export interface Comment {
  id: string;
  text: string;
  author?: string;
  createdAt?: string;
}

/** O corpo vem como JSON do editor (Draft.js: `{blocks:[{text}]}`) ou texto puro. */
export function commentText(body: unknown): string {
  if (typeof body !== 'string') return '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObj(parsed) && Array.isArray(parsed.blocks)) {
      return parsed.blocks
        .map((b) => (isObj(b) ? (str(b.text) ?? '') : ''))
        .join('\n')
        .trim();
    }
  } catch {
    // texto puro
  }
  return body.trim();
}

export function toComments(raw: unknown): Comment[] {
  return unwrapList(raw, 'comments').flatMap((c) => {
    if (!isObj(c)) return [];
    const id = pick(c, 'id');
    if (!id) return [];
    return [{ id, text: commentText(c.body ?? c.text), author: personName(c.author), createdAt: pick(c, 'createdAt') }];
  });
}

/** Tenta achar o ID do card no retorno da criação. */
export function extractCardId(raw: unknown): string | undefined {
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  return toCard(raw)?.id ?? (isObj(raw) && isObj(raw.data) ? toCard(raw.data)?.id : undefined);
}
