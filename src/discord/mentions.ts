/**
 * Menções da Goalfy → Discord.
 *
 * A Goalfy grava a menção dentro do texto do comentário como `@{{"<id do usuário>"}}`
 * (e `@{{"everyone"}}` para todos). Ao espelhar o comentário no tópico, o bot:
 *  - troca o ID pelo nome do membro do board;
 *  - procura a pessoa no servidor do Discord e, se achar com CERTEZA, marca de verdade (<@id>);
 *  - se não achar (ou houver dúvida), mostra só "@Nome", sem marcar ninguém por engano.
 */
import type { Guild, GuildMember } from 'discord.js';
import type { BotContext } from '../context.js';
import type { Member } from '../goalfy/types.js';
import { logger } from '../logger.js';
import { normalize } from '../process.js';

export const MENTION_PATTERN = /@\{\{\s*"([^"]+)"\s*\}\}/g;

/** IDs da Goalfy mencionados no texto (sem repetir, sem o "everyone"). */
export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION_PATTERN)].map((m) => m[1]!).filter((id) => id !== 'everyone'))];
}

/** Partes do nome/e-mail usadas para reconhecer a pessoa no Discord. */
const compact = (s: string) => normalize(s).replace(/[^a-z0-9]/g, '');

/**
 * Correspondência exata entre um membro da Goalfy e um membro do Discord:
 * nome igual ao apelido/nome global/username, ou username igual à parte do e-mail antes do "@".
 */
export function isSamePerson(goalfy: Pick<Member, 'name' | 'email'>, discord: { displayName?: string; globalName?: string | null; username: string }): boolean {
  const name = compact(goalfy.name);
  const local = goalfy.email ? compact(goalfy.email.split('@')[0]!) : '';
  const candidates = [discord.displayName, discord.globalName ?? undefined, discord.username].filter((s): s is string => !!s).map(compact);
  return (name.length >= 3 && candidates.includes(name)) || (local.length >= 3 && compact(discord.username) === local);
}

/** Escolhe o membro do Discord só se houver exatamente uma correspondência. */
export function pickMember<T extends { user: { id: string; username: string; globalName?: string | null }; displayName?: string }>(
  goalfy: Pick<Member, 'name' | 'email'>,
  candidates: T[],
): T | undefined {
  const matches = candidates.filter((m) =>
    isSamePerson(goalfy, { displayName: m.displayName, globalName: m.user.globalName, username: m.user.username }),
  );
  const unique = [...new Map(matches.map((m) => [m.user.id, m])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

const CACHE_TTL_MS = 24 * 60 * 60_000;
const cache = new Map<string, { discordId: string | null; at: number }>();

async function findDiscordMember(guild: Guild, member: Member): Promise<string | null> {
  const hit = cache.get(member.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.discordId;

  const queries = [...new Set([member.name.split(/\s+/)[0], member.email?.split('@')[0]].filter((q): q is string => !!q && q.length >= 2))];
  const found = new Map<string, GuildMember>();
  for (const query of queries) {
    try {
      const result = await guild.members.search({ query, limit: 50 });
      for (const [id, m] of result) found.set(id, m);
    } catch (e) {
      logger.debug(`Busca de membro no Discord falhou para "${query}"`, e);
    }
  }
  const match = pickMember(member, [...found.values()]);
  const discordId = match?.user.id ?? null;
  cache.set(member.id, { discordId, at: Date.now() });
  return discordId;
}

export interface RenderedMentions {
  /** Texto com as menções trocadas por <@id> (encontrado) ou @Nome (não encontrado). */
  text: string;
  /** Usuários do Discord a marcar (vão no conteúdo da mensagem, que é o que notifica). */
  userIds: string[];
}

/** Troca as menções da Goalfy no texto, resolvendo as pessoas no Discord. */
export async function renderMentions(
  text: string,
  resolve: (goalfyUserId: string) => Promise<{ name: string; discordId: string | null } | undefined>,
): Promise<RenderedMentions> {
  const resolved = new Map<string, { name: string; discordId: string | null } | undefined>();
  for (const id of mentionedIds(text)) resolved.set(id, await resolve(id).catch(() => undefined));
  const userIds = [...new Set([...resolved.values()].map((r) => r?.discordId).filter((id): id is string => !!id))];
  const out = text.replace(MENTION_PATTERN, (_, id: string) => {
    if (id === 'everyone') return '@todos';
    const r = resolved.get(id);
    if (!r) return '@alguém';
    return r.discordId ? `<@${r.discordId}>` : `@${r.name}`;
  });
  return { text: out, userIds };
}

/** Resolver real: membro do board na Goalfy → membro do servidor do Discord. */
export function mentionResolver(ctx: BotContext) {
  return async (goalfyUserId: string) => {
    const member = (await ctx.board.members()).find((m) => m.id === goalfyUserId);
    if (!member) return undefined;
    const guild = ctx.client.guilds.cache.get(ctx.config.DISCORD_GUILD_ID);
    const discordId = guild ? await findDiscordMember(guild, member) : null;
    return { name: member.name, discordId };
  };
}
