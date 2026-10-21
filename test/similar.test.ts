/**
 * Cards parecidos no painel de triagem: só sugere quando o ASSUNTO bate (≥ 2 palavras em comum),
 * para não encher o painel com qualquer card que tenha "erro" ou "cliente" no título.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keywords, rankSimilar } from '../src/discord/triage.js';

describe('cards parecidos', () => {
  it('ignora palavras genéricas e acentos', () => {
    assert.deepEqual(keywords('Erro na indexação dos cards'), ['indexacao', 'cards']);
  });

  it('ordena por palavras do assunto em comum e corta os fracos', () => {
    const cards = [
      { id: '1', title: 'Indexação de cards falhando no Elastic' },
      { id: '2', title: 'Cards duplicados no board' },
      { id: '3', title: 'Erro ao salvar meta' },
      { id: '4', title: 'Reindexar cards após importação; indexação lenta dos cards' },
    ];
    assert.deepEqual(rankSimilar('Erro na indexação dos cards', cards).map((c) => c.id), ['1', '4']);
  });

  it('título sem palavra de assunto não sugere nada', () => {
    assert.deepEqual(rankSimilar('Erro no cliente', [{ id: '1', title: 'Erro no cliente' }]), []);
  });
});
