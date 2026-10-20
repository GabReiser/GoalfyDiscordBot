/**
 * Menções da Goalfy (`@{{"<id>"}}` no texto do comentário) → marcação no Discord.
 * Regra principal: só marca quando há certeza; na dúvida, mostra "@Nome" sem marcar.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSamePerson, mentionedIds, pickMember, renderMentions } from '../src/discord/mentions.js';

const GUS = '11111111-1111-4111-8111-111111111111';
const DOUG = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';

describe('menções da Goalfy no texto', () => {
  it('extrai os IDs mencionados (formato do backend), sem repetir e sem o "everyone"', () => {
    const text = `Oi @{{"${GUS}"}} e @{{ "${DOUG}" }}, de novo @{{"${GUS}"}} e @{{"everyone"}}`;
    assert.deepEqual(mentionedIds(text), [GUS, DOUG]);
  });
});

describe('reconhecer a pessoa no Discord (correspondência exata)', () => {
  const gustavo = { name: 'Gustavo Floriano', email: 'gustavo.floriano@goalfy.com.br' };

  it('nome igual (sem acento/caixa/espaço) ou username igual ao e-mail', () => {
    assert.ok(isSamePerson(gustavo, { displayName: 'Gustavo Floriano', username: 'gus123' }));
    assert.ok(isSamePerson(gustavo, { displayName: 'GUS', globalName: 'gustavo floriano', username: 'x' }));
    assert.ok(isSamePerson(gustavo, { displayName: 'Gus', username: 'gustavo.floriano' }));
    assert.ok(isSamePerson({ name: 'Ana Luísa Comper' }, { displayName: 'Ana Luisa Comper', username: 'aninha' }));
  });

  it('nome parecido não basta (evita marcar a pessoa errada)', () => {
    assert.ok(!isSamePerson(gustavo, { displayName: 'Gustavo', username: 'gustavo' }));
    assert.ok(!isSamePerson(gustavo, { displayName: 'Gustavo Silva', username: 'gsilva' }));
  });

  it('duas pessoas batendo → não marca ninguém', () => {
    const member = (id: string, displayName: string, username: string) => ({ displayName, user: { id, username } });
    const one = pickMember(gustavo, [member('d1', 'Gustavo Floriano', 'gf'), member('d2', 'Gustavo', 'gustavo')]);
    assert.equal(one?.user.id, 'd1');
    const two = pickMember(gustavo, [member('d1', 'Gustavo Floriano', 'gf'), member('d3', 'x', 'gustavo.floriano')]);
    assert.equal(two, undefined);
  });
});

describe('texto no tópico', () => {
  const resolve = async (id: string) =>
    ({
      [GUS]: { name: 'Gustavo Floriano', discordId: '900' },
      [DOUG]: { name: 'Douglas Maia', discordId: null },
    })[id];

  it('encontrado vira marcação; não encontrado vira @Nome; desconhecido vira @alguém; everyone vira @todos', async () => {
    const r = await renderMentions(`@{{"${GUS}"}} olha isso, @{{"${DOUG}"}} e @{{"${GONE}"}} também. @{{"everyone"}}`, resolve);
    assert.equal(r.text, '<@900> olha isso, @Douglas Maia e @alguém também. @todos');
    assert.deepEqual(r.userIds, ['900'], 'só quem foi encontrado é notificado (nunca @everyone)');
  });

  it('comentário sem menção fica igual', async () => {
    const r = await renderMentions('sem menção', resolve);
    assert.deepEqual(r, { text: 'sem menção', userIds: [] });
  });
});
