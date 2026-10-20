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
  /** Fase em que o card nasce (padrão: a inicial do board). */
  phaseId?: string;
  /** Evidências do tópico (anexos do Discord): copiadas para a Goalfy, porque os links do Discord vencem. */
  attachments?: SourceAttachment[];
}

export interface SourceAttachment {
  /** ID do anexo no Discord (para não copiar o mesmo arquivo duas vezes no mesmo card). */
  id?: string;
  name: string;
  url: string;
  contentType?: string;
  size?: number;
}

export interface AttachmentReport {
  copied: string[];
  failed: string[];
  /** URLs (Discord) dos arquivos copiados com sucesso. */
  copiedUrls?: Set<string>;
}

/**
 * Caminho do arquivo na resposta do upload. /files/upload devolve `{ url, path }`, mas
 * /public/files/upload/{boardId} devolve embrulhado com o nome da classe:
 * `{ "FileResponse": { url, path, … } }`. Aceita os dois.
 */
export function uploadedPath(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.path === 'string' && obj.path) return obj.path;
  const inner = obj.FileResponse ?? Object.values(obj).find((v) => v && typeof v === 'object' && typeof (v as Record<string, unknown>).path === 'string');
  const path = inner && typeof inner === 'object' ? (inner as Record<string, unknown>).path : undefined;
  return typeof path === 'string' && path ? path : undefined;
}

/** Caminhos já gravados num campo de anexo (lista, JSON ou texto separado por vírgula). */
export function attachmentPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  const v = value.trim();
  if (v.startsWith('[')) {
    try {
      return (JSON.parse(v) as unknown[]).map(String).filter(Boolean);
    } catch {
      // segue para o formato separado por vírgula
    }
  }
  return v.split(',').map((p) => p.trim()).filter(Boolean);
}

/** Troca cada trecho (ex.: link do Discord) pelo correspondente. */
export function replaceUrls(text: string, map: Map<string, string>): string {
  let out = text;
  for (const [from, to] of map) out = out.split(from).join(to);
  return out;
}

/** Limites da cópia de evidências (por card). */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Nome aceito no caminho do armazenamento: sem acento, espaço ou caractere especial (como o front faz). */
export function safeFileName(name: string): string {
  const clean = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+/, '');
  return (clean || 'arquivo').slice(-120);
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

  /**
   * Copia anexos do Discord para o armazenamento da Goalfy e devolve os caminhos permanentes.
   * Precisa rodar enquanto o link assinado do Discord ainda vale (~24h). Falha num arquivo não
   * impede os outros nem a criação do card.
   */
  async importAttachments(attachments: SourceAttachment[]): Promise<{ paths: string[]; copiedUrls: Set<string> } & AttachmentReport> {
    const paths: string[] = [];
    const copiedUrls = new Set<string>();
    const copied: string[] = [];
    const failed: string[] = [];
    for (const a of attachments.slice(0, MAX_ATTACHMENTS)) {
      try {
        if (a.size && a.size > MAX_ATTACHMENT_BYTES) throw new Error(`maior que ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
        const res = await fetch(a.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`Discord respondeu ${res.status} (link vencido?)`);
        const data = new Uint8Array(await res.arrayBuffer());
        // Privado: o arquivo fica no armazenamento da Goalfy e é referenciado pelo caminho
        // (permanente) no campo de anexo; a Goalfy gera o link de visualização a cada acesso.
        // O conteúdo só passa pela memória do bot durante a cópia.
        const raw = await this.client.uploadFile(this.board.boardId, safeFileName(a.name), data, a.contentType ?? res.headers.get('content-type') ?? undefined);
        const path = uploadedPath(raw);
        if (!path) throw new Error('a Goalfy não devolveu o caminho do arquivo');
        paths.push(path);
        copiedUrls.add(a.url);
        copied.push(a.name);
      } catch (e) {
        logger.warn(`Não consegui copiar o anexo "${a.name}" para a Goalfy: ${(e as Error).message}`);
        failed.push(a.name);
      }
    }
    for (const a of attachments.slice(MAX_ATTACHMENTS)) failed.push(a.name);
    return { paths, copiedUrls, copied, failed };
  }

/**
   * Acrescenta arquivos ao campo de anexo de um card já criado, mantendo os que já estão lá
   * (mesmo formato do front: caminhos separados por vírgula).
   */
  async appendAttachments(cardId: string, attachments: SourceAttachment[]): Promise<AttachmentReport & { fieldName?: string }> {
    const field = (await this.board.createForm()).fields.attachments;
    if (!field) return { copied: [], failed: attachments.map((a) => a.name), copiedUrls: new Set() };
    const card = await this.get(cardId);
    if (!card.initialForm) throw new Error('Não encontrei o formulário inicial deste card na Goalfy.');

    const imported = await this.importAttachments(attachments);
    if (imported.paths.length) {
      const existing = card.initialForm.fields.find((f) => f.infoId === field.fieldInfoId);
      const value = [...attachmentPaths(existing?.value), ...imported.paths].join(',');
      if (existing?.id) await this.client.updateCardField(existing.id, value);
      else await this.client.fillCardField(card.initialForm.id, cardId, field.fieldInfoId, value);
    }
    return { copied: imported.copied, failed: imported.failed, copiedUrls: imported.copiedUrls, fieldName: field.name };
  }

  async create(input: NewCardInput): Promise<Card & { attachmentReport?: AttachmentReport }> {
    const form = await this.board.createForm();
    const values: FieldInputs = { ...input.values };
    if (form.fields.title) values[form.fields.title.fieldInfoId] = input.title;
    if (form.fields.discordLink && input.discordUrl) values[form.fields.discordLink.fieldInfoId] = input.discordUrl;
    if (form.fields.requester) values[form.fields.requester.fieldInfoId] = input.requester;

    // Valida antes de copiar anexos: se algo for recusado, não sobe arquivo à toa.
    const attachField = form.fields.attachments;
    const pre = buildFieldValues(attachField ? form.allFields.filter((f) => f !== attachField) : form.allFields, values);
    if (pre.problems.length) throw new InvalidFieldValuesError(pre.problems);

    // Evidências vão para o campo de anexo. Sem esse campo no formulário não há onde guardar:
    // o link do Discord fica na descrição (e vence em ~24h).
    let attachmentReport: AttachmentReport | undefined;
    if (attachField && input.attachments?.length) {
      const imported = await this.importAttachments(input.attachments);
      // Na descrição, o link do Discord (que vai vencer) vira uma referência ao anexo.
      const descriptionId = form.fields.description?.fieldInfoId;
      const description = descriptionId ? values[descriptionId] : undefined;
      if (descriptionId && description) {
        const note = new Map([...imported.copiedUrls].map((url) => [`: ${url}`, ` (no campo ${attachField.name} do card)`]));
        values[descriptionId] = (Array.isArray(description) ? description : [description]).map((text) => replaceUrls(text, note));
      }
      if (imported.paths.length) values[attachField.fieldInfoId] = imported.paths;
      attachmentReport = { copied: imported.copied, failed: imported.failed, copiedUrls: imported.copiedUrls };
    }

    const { fields, problems } = buildFieldValues(form.allFields, values);
    if (problems.length) throw new InvalidFieldValuesError(problems);

    const raw = await this.client.createCard(form.modelId, fields, input.phaseId);
    const id = extractCardId(raw);
    if (!id) {
      logger.error('Card criado, mas não encontrei o ID na resposta', raw);
      throw new Error('A Goalfy criou o card mas não retornou o ID.');
    }

    await this.client.setCardTitle(id, input.title).catch((e) => logger.warn(`Não consegui definir o título do card ${id}`, e));

    // Rastreabilidade: quem abriu e onde está a conversa, se o formulário não tiver campo para isso.
    const lines = [`Card aberto via Discord por ${input.requester}.`];
    if (input.discordUrl && !form.fields.discordLink) lines.push(`Tópico: ${input.discordUrl}`);
    if (attachmentReport?.failed.length) {
      lines.push(`Evidências que não consegui copiar para a Goalfy (veja no tópico): ${attachmentReport.failed.join(', ')}`);
    }
    await this.comment(id, lines.join('\n')).catch((e) => logger.warn(`Não consegui comentar no card ${id}`, e));

    const card = (await this.get(id).catch(() => undefined)) ?? {
      id,
      title: input.title,
      responsibles: [],
      tags: [],
      phaseId: input.phaseId ?? form.initialPhase.id,
      phaseName: input.phaseId ? undefined : form.initialPhase.title,
      phaseForms: [],
    };
    return { ...card, attachmentReport };
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

  /** Define o responsável do card (e-mail de um membro do board). */
  addResponsible(cardId: string, email: string) {
    return this.client.addResponsible(cardId, email);
  }

  comment(cardId: string, text: string) {
    return this.client.addComment(cardId, `${BOT_COMMENT_PREFIX} ${text}`);
  }
}
