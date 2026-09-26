import { normalize } from './process.js';

/**
 * Leitura do template de abertura de N2/N3 (seção 11 do processo).
 *
 * Aceita formatos livres como:
 *   **Origem:** Suporte          Origem - Suporte
 *   **Comportamento atual**      ## Como reproduzir
 *   texto em várias linhas…      1. passo …
 */

export const TOPIC_SECTIONS = {
  title: { label: 'Título', aliases: ['titulo'] },
  origin: { label: 'Origem', aliases: ['origem'] },
  client: { label: 'Cliente / Organização', aliases: ['cliente organizacao', 'cliente', 'organizacao'] },
  environment: { label: 'Ambiente', aliases: ['ambiente'] },
  current: { label: 'Comportamento atual', aliases: ['comportamento atual', 'o que acontece', 'problema'] },
  expected: { label: 'Comportamento esperado', aliases: ['comportamento esperado', 'resultado esperado', 'o que deveria acontecer'] },
  steps: { label: 'Como reproduzir', aliases: ['como reproduzir', 'passos para reproduzir', 'passos'] },
  evidence: { label: 'Evidências', aliases: ['evidencias', 'evidencia', 'prints', 'logs'] },
  impact: { label: 'Impacto', aliases: ['impacto'] },
} as const;

export type TopicSection = keyof typeof TOPIC_SECTIONS;
export type ParsedTopic = Partial<Record<TopicSection, string>>;

/** Informações mínimas que a triagem precisa para começar. */
const RECOMMENDED: TopicSection[] = ['origin', 'environment', 'current', 'expected', 'steps', 'evidence', 'impact'];

const aliasIndex = Object.entries(TOPIC_SECTIONS)
  .flatMap(([key, s]) => s.aliases.map((alias) => ({ key: key as TopicSection, alias })))
  .sort((a, b) => b.alias.length - a.alias.length);

function headerOf(line: string): { key: TopicSection; rest: string } | undefined {
  // Remove marcação de título/lista/citação e negrito antes de comparar.
  const stripped = line.replace(/^\s*(?:#{1,6}\s*|>\s*|[-*•]\s+|\d+[.)]\s+)?/, '').trim();
  const m = stripped.match(/^(?:\*\*|__)?([^:*_\n–-]{3,40}?)(?:\*\*|__)?\s*(?:[:–-]\s*(?:\*\*|__)?\s*(.*))?$/);
  if (!m?.[1]) return undefined;
  const name = normalize(m[1]);
  const hit = aliasIndex.find((a) => name === a.alias);
  return hit && { key: hit.key, rest: (m[2] ?? '').replace(/^(?:\*\*|__)|(?:\*\*|__)$/g, '').trim() };
}

export function parseTopic(content: string): ParsedTopic {
  const out: ParsedTopic = {};
  let current: TopicSection | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (current) {
      const text = buffer.join('\n').trim();
      if (text && !out[current]) out[current] = text;
    }
    buffer = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const h = headerOf(line);
    if (h) {
      flush();
      current = h.key;
      if (h.rest) buffer.push(h.rest);
    } else if (current) {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

export function missingSections(parsed: ParsedTopic, hasAttachments: boolean): string[] {
  return RECOMMENDED.filter((k) => !parsed[k] && !(k === 'evidence' && hasAttachments)).map((k) => TOPIC_SECTIONS[k].label);
}

export const TEMPLATE_HINT = [
  '**Título** — descrição objetiva do problema',
  '**Origem:** Suporte | Consultoria | Produto | Interno | Outra',
  '**Cliente / Organização:** quando aplicável',
  '**Ambiente:** Produção | Homologação | Desenvolvimento',
  '**Comportamento atual:** o que está acontecendo',
  '**Comportamento esperado:** o que deveria acontecer',
  '**Como reproduzir:** passos para chegar ao problema',
  '**Evidências:** print, vídeo, log, mensagem de erro',
  '**Impacto:** como isso afeta o usuário/cliente',
].join('\n');
