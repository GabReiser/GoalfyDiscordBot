import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BotContext } from '../src/context.js';
import { alertKey, startAlerts } from '../src/discord/alerts.js';
import { logger } from '../src/logger.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

function ctxWith(send: (p: unknown) => Promise<unknown>) {
  const sent: { embeds: { toJSON(): { title?: string; description?: string } }[] }[] = [];
  const channel = {
    isSendable: () => true,
    send: async (p: never) => {
      sent.push(p);
      return send(p);
    },
  };
  const ctx = {
    config: { DISCORD_LOG_CHANNEL_ID: '1507106301837312150' },
    client: { channels: { fetch: async () => channel } },
  } as unknown as BotContext;
  return { ctx, sent };
}

describe('alertas no Discord', () => {
  it('mensagens iguais a menos de IDs/números caem no mesmo grupo', () => {
    const a = alertKey({ level: 'warn', msg: 'Sem acesso ao card 86a8d638-2f2a-420f-b6d3-8af5c219f691 (403, tentativa 1/3)' });
    const b = alertKey({ level: 'warn', msg: 'Sem acesso ao card 11111111-2222-4333-8444-555555555555 (403, tentativa 2/3)' });
    assert.equal(a, b);
    assert.notEqual(a, alertKey({ level: 'error', msg: 'Sem acesso ao card x (403, tentativa 1/3)' }));
  });

  it('só erros vão para o canal, agrupados com ×N (avisos ficam no log)', async () => {
    const { ctx, sent } = ctxWith(async () => undefined);
    const stop = startAlerts(ctx);
    logger.warn('Interação /triagem: resposta 1778ms: LENTA');
    logger.error('Goalfy GET /cards/1 → 500');
    logger.error('Goalfy GET /cards/2 → 500');
    logger.error('Falha ao criar card', new Error('timeout'));
    logger.info('isso não é alerta');
    stop(); // força o envio da janela
    await tick();

    assert.equal(sent.length, 1);
    const embed = sent[0]!.embeds[0]!.toJSON();
    assert.equal(embed.title, '❌ 3 erro(s)');
    const [first, second, third] = embed.description!.split('\n');
    assert.match(first!, /❌ \*\*×2\*\* Goalfy GET/);
    assert.match(second!, /❌ Falha ao criar card: timeout/);
    assert.equal(third, undefined, 'o aviso de lentidão não aparece');
  });

  it('janela só com avisos não posta nada', async () => {
    const { ctx, sent } = ctxWith(async () => undefined);
    const stop = startAlerts(ctx);
    logger.warn('Interação /card: resposta 2100ms: LENTA');
    stop();
    await tick();
    assert.equal(sent.length, 0);
  });

  it('falha ao postar não gera alerta sobre o alerta (sem loop)', async () => {
    const { ctx, sent } = ctxWith(async () => {
      throw new Error('Missing Access');
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const stop = startAlerts(ctx);
      logger.error('primeiro erro');
      stop();
      await tick();
      const stop2 = startAlerts(ctx);
      stop2(); // nada novo na janela → não tenta enviar
      await tick();
    } finally {
      console.error = originalError;
    }
    assert.equal(sent.length, 1, 'tentou só uma vez, sem realimentar');
  });
});
