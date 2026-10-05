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
import { planCreate } from '../goalfy/formPlan.js';
import { type FormField, toCards, toPhaseFields, toPhases, unwrapList } from '../goalfy/types.js';

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
  const responsible = await board.responsibleField().catch(() => undefined);
  const plan = planCreate(form, responsible?.field);
  const fmt = (f: FormField) => `${f.name}${f.required ? ' *' : ''}${f.options.length ? ` [${f.options.slice(0, 6).join(' | ')}${f.options.length > 6 ? ' …' : ''}]` : ''}`;

  console.log(`\nFormulário de criação: modelId=${form.modelId} (o card nasce em: ${form.initialPhase.title})`);
  console.log('\nO que o bot vai perguntar ao criar um card (* = obrigatório):');
  console.log(`  Modal 1:\n    • Título do card *${plan.titleField ? ` → também preenche "${plan.titleField.name}"` : ''}`);
  for (const f of plan.selects) console.log(`    • ${fmt(f)}`);
  console.log('  Modal 2:', plan.modal.length ? '' : '(nenhum: cria direto após o modal 1)');
  for (const f of plan.modal) console.log(`    • ${fmt(f)}`);
  if (plan.auto.length) console.log(`  Automático: ${plan.auto.map((f) => f.name).join(', ')}`);
  if (plan.skipped.length) console.log(`  Não perguntado (opcional): ${plan.skipped.map((f) => f.name).join(', ')}`);
  if (plan.missingRequired.length) {
    console.log(`  ⚠️  OBRIGATÓRIOS QUE O BOT NÃO CONSEGUE PREENCHER: ${plan.missingRequired.map(fmt).join(', ')}`);
  }

  const creatable = await board.creatablePhases();
  console.log(
    `\nFases em que o card pode nascer: ${creatable.map((p) => p.title).join(', ')}` +
      (creatable.length === 1 ? '\n  (para liberar outras: "criar card direto" na fase, na Goalfy, ou GOALFY_CREATE_PHASES)' : ''),
  );

  console.log('\nFases com campos obrigatórios (o bot pede antes de mover):');
  let any = false;
  for (const p of phases) {
    const required = (await board.phaseFields(p).catch(() => [])).filter((f) => f.required);
    if (!required.length) continue;
    any = true;
    const when = board.isDone(p) ? 'ao entrar (fase final)' : 'antes de avançar';
    console.log(`  • ${p.title} (${when}): ${required.map(fmt).join(', ')}`);
  }
  if (!any) console.log('  (nenhuma)');

  const done = phases.filter((p) => board.isDone(p));
  console.log(
    '\nFases finais:',
    done.map((p) => `${p.title}${board.isCancel(p) ? ' (❌ cancelamento)' : ' (✅ entrega)'}`).join(', ') || '(nenhuma detectada: defina GOALFY_DONE_PHASES)',
  );
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
