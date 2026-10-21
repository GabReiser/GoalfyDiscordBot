import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { missingBasics, missingSections, parseTopic } from '../src/topicTemplate.js';

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

describe('bloco de identificação do chamado (Org / Usuário / Link do board + relatório)', () => {
  const block = [
    '**Org:** poenatela',
    '**Usuário:** Filipe',
    '**Link do board + relatório:**',
    'https://app.goalfy.com.br/board/24a0d834-71f6-405f-bfbb-04916f20e438/reports/d4e75616-5b22-4542-8cf8-93510fdf9928',
    '',
    'O relatório não carrega depois de filtrar por responsável.',
  ].join('\n');
  const missing = (content: string, attachments = false) => missingBasics(content, parseTopic(content), attachments);

  it('bloco completo + print: não pede nada', () => {
    assert.deepEqual(missing(block, true), []);
  });

  it('sem print: pede só a evidência', () => {
    assert.deepEqual(missing(block), ['Print ou vídeo do problema']);
  });

  it('texto livre sem o bloco: pede org, usuário e link', () => {
    assert.deepEqual(missing('O cliente reclamou que o relatório não carrega desde ontem', true), ['Org', 'Usuário', 'Link do board + relatório']);
  });

  it('aceita variações ("Org - x", "Organização: x", "Usuária: x")', () => {
    assert.deepEqual(missing('Organização: ACME\nUsuária - Ana\nhttps://app.goalfy.com.br/board/1', true), []);
    assert.deepEqual(missing('Org - ACME\nUser: ana\nhttps://goalfy.com.br/x', true), []);
  });
});
