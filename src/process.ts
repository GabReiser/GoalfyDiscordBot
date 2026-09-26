/**
 * Regras do "Processo de N2/N3, Sustentação e Gestão de Demandas" (notion.md).
 * Ajuste aqui para refletir mudanças no processo — o resto do bot lê daqui.
 */

export interface Choice {
  value: string;
  label: string;
  emoji: string;
  description?: string;
}

// ── Classificação do card (seção 12) ────────────────────────────────────────

export const FRONTS = [
  { value: 'Sustentação', label: 'Sustentação', emoji: '🛠️', description: 'Bugs, regressões, incidentes, correções' },
  { value: 'Engenharia', label: 'Engenharia', emoji: '🏗️', description: 'Arquitetura, performance, segurança, infra, dívida técnica' },
  { value: 'Produto', label: 'Produto', emoji: '🚀', description: 'Features e evoluções funcionais' },
] as const satisfies Choice[];

export type Front = (typeof FRONTS)[number]['value'];

/** Tipo → frente sugerida, conforme a tabela de classificação (seção 5.3). */
export const TYPES: (Choice & { front: Front })[] = [
  { value: 'Bug', label: 'Bug', emoji: '🐞', front: 'Sustentação', description: 'Comportamento existente incorreto' },
  { value: 'Regressão', label: 'Regressão', emoji: '↩️', front: 'Sustentação', description: 'Funcionava e parou de funcionar' },
  { value: 'Melhoria', label: 'Melhoria', emoji: '✨', front: 'Produto', description: 'Evolução funcional' },
  { value: 'Feature', label: 'Feature', emoji: '🧩', front: 'Produto', description: 'Necessidade de novo comportamento' },
  { value: 'Performance', label: 'Performance', emoji: '⚡', front: 'Engenharia', description: 'Problema estrutural de performance' },
  { value: 'Segurança', label: 'Segurança', emoji: '🔒', front: 'Engenharia' },
  { value: 'Tech Debt', label: 'Tech Debt', emoji: '🧹', front: 'Engenharia', description: 'Dívida técnica' },
  { value: 'DevOps', label: 'DevOps', emoji: '⚙️', front: 'Engenharia', description: 'Infraestrutura / deploy / observabilidade' },
];

export const ORIGINS: Choice[] = [
  { value: 'Suporte', label: 'Suporte', emoji: '🎧' },
  { value: 'Consultoria', label: 'Consultoria', emoji: '🤝' },
  { value: 'Produto', label: 'Produto', emoji: '🚀' },
  { value: 'Interno', label: 'Interno', emoji: '🏢' },
  { value: 'Outra', label: 'Outra', emoji: '📥' },
];

/** Severidade ≠ prioridade (seção 13). Só se aplica a problemas/bugs. */
export const SEVERITIES: Choice[] = [
  { value: 'S1 — Crítico', label: 'S1 — Crítico', emoji: '🔴', description: 'Operação indisponível, perda de dados, segurança crítica' },
  { value: 'S2 — Alto', label: 'S2 — Alto', emoji: '🟠', description: 'Função importante bloqueada, sem alternativa adequada' },
  { value: 'S3 — Médio', label: 'S3 — Médio', emoji: '🟡', description: 'Impacto limitado ou existe workaround' },
  { value: 'S4 — Baixo', label: 'S4 — Baixo', emoji: '⚪', description: 'Impacto pequeno, visual ou pouco frequente' },
  { value: 'N/A', label: 'Não se aplica', emoji: '➖', description: 'Não é um problema/bug' },
];

export const typeFront = (type: string | undefined): Front | undefined => TYPES.find((t) => t.value === type)?.front;

/**
 * Tags do fórum que o solicitante escolhe ao abrir o tópico → severidade pré-selecionada
 * na classificação (a triagem pode mudar). Chave comparada sem acento/caixa/emoji.
 */
export const SEVERITY_TAGS: Record<string, string> = {
  major: 'S1 — Crítico',
  'atencao especial': 'S3 — Médio',
};

// ── Status do tópico no Discord (seção 14) ──────────────────────────────────

export const TOPIC_STATUS = {
  triage: { tag: 'Em Triagem', emoji: '🔎' },
  waiting: { tag: 'Aguardando Informação', emoji: '⏳' },
  card: { tag: 'Card Criado', emoji: '📋' },
  resolved: { tag: 'Resolvido', emoji: '✅' },
  rejected: { tag: 'Não Procede', emoji: '❌' },
} as const;

export type TopicStatus = keyof typeof TOPIC_STATUS;

/** Status que dão "destino" ao tópico (regra 8: nenhum tópico fica sem destino). */
export const DESTINATION_STATUSES: ReadonlySet<TopicStatus> = new Set(['card', 'resolved', 'rejected']);

// ── Goalfy ──────────────────────────────────────────────────────────────────

/** Fase final que significa "não será feito" (o tópico vira ❌, não ✅). */
export const CANCEL_PHASE_PATTERN = /cancel|arquiv|descart|reprovad/i;

/** Nomes que indicam fase final quando GOALFY_DONE_PHASES não está definido. */
export const DONE_PHASE_PATTERN = /^(?:.*\s)?(produ[cç][aã]o|conclu[ií]do|finalizado|resolvido|done|cancelado|encerrado)$/i;

/**
 * Nomes candidatos para detectar os campos do formulário do card automaticamente.
 * A comparação ignora acento e caixa; tenta igualdade e depois "contém".
 */
export const FIELD_ALIASES = {
  title: ['titulo', 'title', 'assunto', 'resumo'],
  description: ['descricao', 'description', 'detalhes', 'detalhamento'],
  expectedResult: ['resultado esperado', 'criterio de aceite', 'criterios de aceite', 'definicao de pronto'],
  front: ['frente'],
  type: ['tipo', 'type', 'natureza'],
  origin: ['origem'],
  client: ['cliente', 'organizacao', 'empresa'],
  severity: ['severidade', 'criticidade', 'severity'],
  discordLink: ['discord', 'link do topico', 'topico'],
  ticketLink: ['ticket', 'n1', 'chamado'],
  requester: ['solicitante', 'reportado por', 'aberto por', 'requester'],
} as const;

export type LogicalField = keyof typeof FIELD_ALIASES;

/** Prefixo dos comentários que o bot escreve na Goalfy (usado para não ecoar de volta). */
export const BOT_COMMENT_PREFIX = '🤖 [Discord]';

// ── Utilitários ─────────────────────────────────────────────────────────────

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const findChoice = (choices: readonly Choice[], value: string | undefined) =>
  choices.find((c) => c.value === value);

export const matchChoice = (choices: readonly Choice[], text: string | undefined) => {
  if (!text) return undefined;
  const n = normalize(text);
  return choices.find((c) => normalize(c.value) === n || normalize(c.label) === n || n.startsWith(normalize(c.value)));
};

export const choiceLabel = (choices: readonly Choice[], value: string | undefined) => {
  const c = findChoice(choices, value);
  return c ? `${c.emoji} ${c.label}` : (value ?? '—');
};
