import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { missingSections, parseTopic } from '../src/topicTemplate.js';

describe('parseTopic', () => {
  it('entende negrito, "Campo:" e títulos markdown', () => {
    const parsed = parseTopic(
      [
        '**Origem:** Suporte',
        '**Cliente / Organização:** ACME Ltda',
        'Ambiente - Produção',
        '**Comportamento atual**',
        'Erro 500 ao salvar.',
        'Acontece sempre.',
        '## Como reproduzir',
        '1. Abrir funil',
        '2. Salvar',
        '**Comportamento esperado:** Salvar normalmente',
      ].join('\n'),
    );
    assert.deepEqual(parsed, {
      origin: 'Suporte',
      client: 'ACME Ltda',
      environment: 'Produção',
      current: 'Erro 500 ao salvar.\nAcontece sempre.',
      steps: '1. Abrir funil\n2. Salvar',
      expected: 'Salvar normalmente',
    });
  });

  it('não confunde texto comum com cabeçalho', () => {
    assert.deepEqual(parseTopic('O cliente disse que o problema começou ontem.'), {});
  });

  it('aponta o que falta; anexos contam como evidência', () => {
    const parsed = parseTopic('Origem: Consultoria\nImpacto: alto');
    assert.deepEqual(missingSections(parsed, true), ['Ambiente', 'Comportamento atual', 'Comportamento esperado', 'Como reproduzir']);
    assert.ok(missingSections(parsed, false).includes('Evidências'));
  });
});
