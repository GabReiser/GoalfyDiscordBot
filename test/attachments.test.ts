/**
 * Evidências do Discord: os links da CDN do Discord vencem em ~24h. O bot baixa cada arquivo
 * (só em memória, durante a cópia) e envia para o armazenamento PRIVADO da Goalfy, gravando o
 * caminho no campo de anexo do card. O caminho não vence; a Goalfy gera o link a cada acesso.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BoardService } from '../src/goalfy/board.js';
import { attachmentPaths, CardService, replaceUrls, safeFileName, uploadedPath } from '../src/goalfy/cards.js';
import type { GoalfyClient } from '../src/goalfy/client.js';

const DISCORD = 'https://cdn.discordapp.com/attachments/1/2/print%20tela.png?ex=abc&is=def&hm=123';
const DISCORD_GONE = 'https://cdn.discordapp.com/attachments/1/3/video.mp4?ex=old';

const realFetch = globalThis.fetch;
beforeEach(() => {
  // Simula a CDN do Discord: o primeiro link vale, o segundo já venceu.
  globalThis.fetch = (async (url: string) =>
    url === DISCORD ? new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } }) : new Response('', { status: 404 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setup(opts: { withAttachmentField?: boolean; cardForm?: unknown } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  let n = 0;
  const fields = [
    { id: 'f-titulo', title: 'Título', fieldType: 'shortText', options: [] },
    { id: 'f-desc', title: 'Descrição', fieldType: 'longText', options: [] },
    ...(opts.withAttachmentField === false ? [] : [{ id: 'f-anexo', title: 'Anexo', fieldType: 'attachment', options: [] }]),
  ];
  const client = {
    listPhases: async () => [{ id: 'p0', index: 0, title: 'Backlog' }],
    getBoardFields: async () => [{ id: 'MODEL', name: 'Formulário Inicial', fields }],
    uploadFile: async (...args: unknown[]) => {
      calls.push({ op: 'upload', args });
      n++;
      // Formato real de /public/files/upload/{boardId}: embrulhado com o nome da classe
      return { FileResponse: { url: `https://storage.googleapis.com/assinada?X-Goog-Expires=900&n=${n}`, path: `uuid-${n}/print_tela.png` } };
    },
    createCard: async (...args: unknown[]) => {
      calls.push({ op: 'create', args });
      return { id: 'NEW' };
    },
    setCardTitle: async () => {},
    addComment: async (_id: string, body: string) => calls.push({ op: 'comment', args: [body] }),
    getCard: async (id: string) => ({ id, title: 't', phase: { id: 'p0' }, form: opts.cardForm }),
    updateCardField: async (...args: unknown[]) => calls.push({ op: 'update', args }),
    fillCardField: async (...args: unknown[]) => calls.push({ op: 'fill', args }),
  } as unknown as GoalfyClient;
  const board = new BoardService(client, { GOALFY_BOARD_ID: 'B1', GOALFY_APP_URL: 'https://app', GOALFY_DONE_PHASES: [], GOALFY_RESPONSIBLES: [], GOALFY_CREATE_PHASES: [] } as never);
  return { cards: new CardService(client, board), calls };
}

const attachments = [
  { name: 'print tela.png', url: DISCORD, contentType: 'image/png', size: 4 },
  { name: 'video.mp4', url: DISCORD_GONE, size: 10 },
];

describe('evidências na criação do card', () => {
  it('copia para o campo de anexo (privado) e tira o link do Discord da descrição', async () => {
    const { cards, calls } = setup();
    const card = await cards.create({
      title: 'Erro ao salvar',
      values: { 'f-desc': [`Erro ao salvar\n\n📎 print tela.png: ${DISCORD}\n📎 video.mp4: ${DISCORD_GONE}`] },
      requester: 'Ana',
      attachments,
    });

    const upload = calls.find((c) => c.op === 'upload')!;
    assert.equal(upload.args[0], 'B1', 'upload na organização DONA DO BOARD (não na do token): é onde o card procura o anexo');
    assert.equal(upload.args[1], 'print_tela.png');
    assert.equal(upload.args.length, 4, 'sem flag de público: upload privado');

    const create = calls.find((c) => c.op === 'create')!;
    const values = Object.fromEntries((create.args[1] as { fieldInfoId: string; value: unknown }[]).map((f) => [f.fieldInfoId, f.value]));
    assert.deepEqual(values['f-anexo'], ['uuid-1/print_tela.png'], 'o campo guarda o caminho permanente');
    const desc = values['f-desc'] as string;
    assert.match(desc, /📎 print tela\.png \(no campo Anexo do card\)/);
    assert.ok(!desc.includes(DISCORD), 'o link do Discord (que vai vencer) saiu da descrição');
    assert.ok(!desc.includes('X-Goog-Expires'), 'nenhum link assinado temporário na descrição');
    assert.ok(desc.includes(DISCORD_GONE), 'o que não deu para copiar fica com o link original');

    assert.deepEqual([card.attachmentReport?.copied, card.attachmentReport?.failed], [['print tela.png'], ['video.mp4']]);
    assert.deepEqual([...card.attachmentReport!.copiedUrls!], [DISCORD], 'URLs copiadas, para registrar e não duplicar');
  });

  it('formulário sem campo de anexo: não copia (não há onde guardar) e mantém o link', async () => {
    const { cards, calls } = setup({ withAttachmentField: false });
    await cards.create({ title: 'T', values: { 'f-desc': [`📎 a.png: ${DISCORD}`] }, requester: 'Ana', attachments });
    assert.equal(calls.some((c) => c.op === 'upload'), false);
    const values = Object.fromEntries((calls.find((c) => c.op === 'create')!.args[1] as { fieldInfoId: string; value: unknown }[]).map((f) => [f.fieldInfoId, f.value]));
    assert.ok((values['f-desc'] as string).includes(DISCORD));
  });
});

describe('Enviar ao card Goalfy: acrescentar ao anexo existente', () => {
  it('campo já preenchido: atualiza mantendo os arquivos que já estavam', async () => {
    const { cards, calls } = setup({
      cardForm: { id: 'FORM-1', fields: [{ id: 'FIELD-9', infoId: 'f-anexo', value: 'antigo-1/a.png,antigo-2/b.png' }] },
    });
    const r = await cards.appendAttachments('c1', attachments);
    assert.deepEqual(calls.find((c) => c.op === 'update')!.args, ['FIELD-9', 'antigo-1/a.png,antigo-2/b.png,uuid-1/print_tela.png']);
    assert.deepEqual([r.copied, r.failed, r.fieldName], [['print tela.png'], ['video.mp4'], 'Anexo']);
  });

  it('campo ainda vazio no card: cria o valor no formulário inicial', async () => {
    const { cards, calls } = setup({ cardForm: { id: 'FORM-1', fields: [] } });
    await cards.appendAttachments('c1', [attachments[0]!]);
    assert.deepEqual(calls.find((c) => c.op === 'fill')!.args, ['FORM-1', 'c1', 'f-anexo', 'uuid-1/print_tela.png']);
  });
});

describe('utilitários', () => {
  it('nome de arquivo seguro para o caminho do armazenamento', () => {
    assert.equal(safeFileName('Print da tela (1) ção.PNG'), 'Print_da_tela_1_cao.PNG');
    assert.equal(safeFileName('???'), 'arquivo');
  });

  it('lê o caminho do upload nos dois formatos da Goalfy (bug de produção: resposta embrulhada)', () => {
    assert.equal(uploadedPath({ url: 'u', path: 'a/1.png' }), 'a/1.png');
    // /public/files/upload/{boardId} (resposta real, 20/10)
    assert.equal(uploadedPath({ FileResponse: { url: 'u', path: 'd912d425/teste-bot.txt', fileId: null } }), 'd912d425/teste-bot.txt');
    assert.equal(uploadedPath({ outro: { path: 'b/2.png' } }), 'b/2.png');
    assert.equal(uploadedPath('File upload failed.'), undefined);
    assert.equal(uploadedPath({ FileResponse: {} }), undefined);
  });

  it('lê os caminhos já gravados em qualquer formato', () => {
    assert.deepEqual(attachmentPaths('a/1.png, b/2.png'), ['a/1.png', 'b/2.png']);
    assert.deepEqual(attachmentPaths('["a/1.png","b/2.png"]'), ['a/1.png', 'b/2.png']);
    assert.deepEqual(attachmentPaths(['a/1.png']), ['a/1.png']);
    assert.deepEqual(attachmentPaths(null), []);
  });

  it('replaceUrls troca todas as ocorrências', () => {
    assert.equal(replaceUrls('a X b X', new Map([['X', 'Y']])), 'a Y b Y');
  });
});
