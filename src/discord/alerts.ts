/**
 * Alertas operacionais num canal do Discord (DISCORD_LOG_CHANNEL_ID), para devs e tech lead:
 *  - WARN/ERROR do bot, agrupados por minuto (mensagens repetidas viram "×N"), para não virar spam;
 *  - quando o bot liga e quando desliga.
 *
 * A visibilidade (ex.: só o cargo Triagem N2) é definida nas permissões do canal no Discord;
 * o diagnóstico (setup.ts) avisa se o canal estiver aberto para @everyone.
 */
import { EmbedBuilder } from 'discord.js';
import type { BotContext } from '../context.js';
import { type LogEntry, logger } from '../logger.js';
import { COLORS, truncate } from './ui.js';

const FLUSH_MS = 60_000;
const MAX_GROUPS = 15;

interface Group {
  level: 'warn' | 'error';
  sample: string;
  count: number;
  last: Date;
}

/** Mensagens iguais a menos de IDs, números e tempos caem no mesmo grupo. */
export function alertKey(e: Pick<LogEntry, 'level' | 'msg'>): string {
  return `${e.level}:${e.msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+/g, '#')
    .slice(0, 120)}`;
}

export function buildAlertEmbed(groups: Group[], windowStart: Date): EmbedBuilder {
  const errors = groups.filter((g) => g.level === 'error').reduce((n, g) => n + g.count, 0);
  const warns = groups.filter((g) => g.level === 'warn').reduce((n, g) => n + g.count, 0);
  const sorted = [...groups].sort((a, b) => Number(b.level === 'error') - Number(a.level === 'error') || b.count - a.count);
  const lines = sorted.slice(0, MAX_GROUPS).map((g) => {
    const icon = g.level === 'error' ? '❌' : '⚠️';
    const times = g.count > 1 ? ` **×${g.count}**` : '';
    return `${icon}${times} ${truncate(g.sample, 300)}`;
  });
  if (sorted.length > MAX_GROUPS) lines.push(`…e mais ${sorted.length - MAX_GROUPS} tipo(s). Veja o painel de logs.`);

  const title = [errors ? `${errors} erro(s)` : '', warns ? `${warns} aviso(s)` : ''].filter(Boolean).join(' e ');
  return new EmbedBuilder()
    .setColor(errors ? COLORS.error : COLORS.warn)
    .setTitle(`${errors ? '❌' : '⚠️'} ${title}`)
    .setDescription(truncate(lines.join('\n'), 4000))
    .setFooter({ text: `Desde ${windowStart.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` })
    .setTimestamp();
}

async function send(ctx: BotContext, payload: { embeds: EmbedBuilder[] }) {
  const id = ctx.config.DISCORD_LOG_CHANNEL_ID;
  if (!id) return;
  const channel = await ctx.client.channels.fetch(id);
  if (!channel?.isSendable()) throw new Error(`canal ${id} não aceita mensagens do bot`);
  await channel.send(payload);
}

/** Envia sem gerar log de WARN (evita alerta sobre falha de alerta, em loop). */
let lastSendFailure = 0;
async function sendQuietly(ctx: BotContext, payload: { embeds: EmbedBuilder[] }) {
  try {
    await send(ctx, payload);
  } catch (e) {
    if (Date.now() - lastSendFailure > 10 * 60_000) {
      lastSendFailure = Date.now();
      console.error(`${new Date().toISOString()} ERROR Não consegui postar no canal de alertas: ${(e as Error).message}`);
    }
  }
}

export function lifecycleEmbed(kind: 'start' | 'stop', details: string[]) {
  return new EmbedBuilder()
    .setColor(kind === 'start' ? COLORS.done : COLORS.muted)
    .setTitle(kind === 'start' ? '🟢 Bot iniciado' : '🔴 Bot desligando')
    .setDescription(details.join('\n') || null)
    .setTimestamp();
}

export function postLifecycle(ctx: BotContext, kind: 'start' | 'stop', details: string[] = []) {
  if (!ctx.config.DISCORD_LOG_CHANNEL_ID) return Promise.resolve();
  // Ao desligar, não segura o processo mais de 3s esperando o Discord.
  return Promise.race([sendQuietly(ctx, { embeds: [lifecycleEmbed(kind, details)] }), new Promise((r) => setTimeout(r, 3000))]);
}

/** Começa a coletar WARN/ERROR e postar um resumo por minuto. Retorna função para parar. */
export function startAlerts(ctx: BotContext): () => void {
  if (!ctx.config.DISCORD_LOG_CHANNEL_ID) return () => {};

  let groups = new Map<string, Group>();
  let windowStart = new Date();

  const unsubscribe = logger.onWarnOrError((e) => {
    const key = alertKey(e);
    const g = groups.get(key);
    const sample = e.detail ? `${e.msg}: ${e.detail}` : e.msg;
    if (g) {
      g.count++;
      g.last = e.at;
    } else {
      groups.set(key, { level: e.level, sample, count: 1, last: e.at });
    }
  });

  const flush = async () => {
    if (!groups.size) return;
    const batch = [...groups.values()];
    const start = windowStart;
    groups = new Map();
    windowStart = new Date();
    await sendQuietly(ctx, { embeds: [buildAlertEmbed(batch, start)] });
  };

  const timer = setInterval(() => void flush(), FLUSH_MS);
  return () => {
    clearInterval(timer);
    unsubscribe();
    void flush();
  };
}

