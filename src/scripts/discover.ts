/**
 * Descobre IDs na Goalfy para preencher o .env: boards, fases e campos do formulário.
 * Só precisa de GOALFY_TOKEN.
 *
 * Uso:
 *   npm run discover                 → lista os boards
 *   npm run discover -- <boardId>    → fases, campos e mapeamento sugerido
 *   npm run discover -- <boardId> --raw  → também imprime as respostas cruas da API
 */
import { loadGoalfyConfig } from '../config.js';
import { BoardService } from '../goalfy/board.js';
import { GoalfyClient } from '../goalfy/client.js';
import { toCards, toPhaseFields, toPhases, unwrapList } from '../goalfy/types.js';

const config = loadGoalfyConfig();
const client = new GoalfyClient(config.GOALFY_API_URL, config.GOALFY_TOKEN);
const args = process.argv.slice(2);
const raw = args.includes('--raw');
const boardId = args.find((a) => !a.startsWith('--')) ?? config.GOALFY_BOARD_ID;

const dump = (label: string, data: unknown) => raw && console.log(`\n── ${label} (cru) ──\n${JSON.stringify(data, null, 2)}`);

const boards = await client.listBoards();
dump('GET /boards', boards);
if (!boardId) {
  console.log('\nBoards disponíveis para este token:\n');
  for (const b of unwrapList(boards) as Record<string, unknown>[]) console.log(`  ${String(b.id).padEnd(12)} ${b.name ?? b.title ?? ''}`);
  console.log('\nRode de novo com: npm run discover -- <boardId>');
  process.exit(0);
}

const phasesRaw = await client.listPhases(boardId);
dump(`GET /phases/board/${boardId}`, phasesRaw);
const phases = toPhases(phasesRaw);
console.log(`\nFases do board ${boardId}:\n`);
for (const p of phases) console.log(`  ${p.id.padEnd(12)} ${p.title.padEnd(30)} modelId=${p.modelId ?? '—'}`);

const fieldsRaw = await client.getBoardFields(boardId);
dump(`GET /${boardId}/fields`, fieldsRaw);
console.log('\nCampos por fase:');
for (const g of toPhaseFields(fieldsRaw)) {
  console.log(`\n  [${g.phaseName ?? g.phaseId ?? '?'}]`);
  for (const f of g.fields) console.log(`    ${f.fieldInfoId.padEnd(40)} ${f.name} (${f.type}${f.required ? ', obrigatório' : ''})`);
}

const board = new BoardService(client, { ...config, GOALFY_BOARD_ID: boardId });
try {
  const form = await board.createForm();
  console.log(`\nFormulário de criação: modelId=${form.modelId} (fase inicial: ${form.initialPhase.title})`);
  console.log('Mapeamento detectado (sobrescreva no .env se estiver errado):\n');
  for (const [k, f] of Object.entries(form.fields)) console.log(`  ${k.padEnd(15)} → ${f.name} (${f.fieldInfoId})`);
  console.log('\nDone phases:', phases.filter((p) => board.isDone(p)).map((p) => p.title).join(', ') || '(nenhuma detectada — defina GOALFY_DONE_PHASES)');
} catch (e) {
  console.error('\nNão consegui montar o formulário de criação:', (e as Error).message);
}

if (raw) {
  const sample = await client.filterCards(boardId, { limit: 2, offset: 0 });
  dump('GET /cards/board/:id/filter (amostra)', sample);
  const first = toCards(sample)[0];
  if (first) {
    dump(`GET /cards/${first.id}`, await client.getCard(first.id));
    dump(`GET /cards/${first.id}/comments`, await client.listComments(first.id));
  }
}
