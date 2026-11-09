/**
 * Changelog semanal: cards que entraram em produção, por Tipo e Módulo, postados segunda 08:00.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BotContext } from '../src/context.js';
import {
  brClock,
  type ChangelogItem,
  collectChangelog,
  dueWindow,
  fieldTexts,
  groupChangelog,
  maintenanceByModule,
  moduleEmoji,
  periodLabel,
  renderChangelog,
} from '../src/discord/weeklyChangelog.js';
import { toCard } from '../src/goalfy/types.js';
import { Store } from '../src/store.js';

const TYPES = ['Feature', 'Melhoria', 'Bug', 'Débito Técnico', 'Infra/DevOps', 'Discovery/Spike'];
const MODULES = ['Home', 'Board/Kanban', 'Report', 'Automation/Flows'];
const item = (title: string, type: string, module: string): ChangelogItem => ({ title, url: `https://app/c/${title}`, type, module });

describe('valores dos campos', () => {
  it('texto, lista ou lista em JSON', () => {
    assert.deepEqual(fieldTexts('Bug'), ['Bug']);
    assert.deepEqual(fieldTexts(['Report']), ['Report']);
    assert.deepEqual(fieldTexts('["Home","Report"]'), ['Home', 'Report']);
    assert.deepEqual(fieldTexts(null), []);
    assert.deepEqual(fieldTexts('  '), []);
  });

  it('histórico do card traz a data de entrada em cada fase', () => {
    const card = toCard({ id: 'c1', title: 'T', phasesHistory: [{ createdAt: '2026-10-28T13:00:00.000', phase: { id: 'prod' }, form: {} }] });
    assert.equal(card?.phaseForms[0]?.enteredAt, '2026-10-28T13:00:00.000');
  });
});

describe('agrupamento', () => {
  it('Tipo e Módulo na ordem das opções da Goalfy; "sem" por último; títulos em ordem alfabética', () => {
    const groups = groupChangelog(
      [
        item('Zeta', 'Bug', 'Report'),
        item('Alfa', 'Bug', 'Report'),
        item('Filtro salvo', 'Feature', 'Report'),
        item('Card some', 'Bug', 'Home'),
        item('Sem nada', 'Sem tipo', 'Sem módulo'),
      ],
      TYPES,
      MODULES,
    );
    assert.deepEqual(groups.map((g) => [g.type, g.count]), [['Feature', 1], ['Bug', 3], ['Sem tipo', 1]]);
    const bug = groups[1]!;
    assert.deepEqual(bug.modules.map((m) => m.module), ['Home', 'Report']);
    assert.deepEqual(bug.modules[1]!.items.map((i) => i.title), ['Alfa', 'Zeta']);
  });
});

describe('mensagem', () => {
  const from = new Date('2026-10-26T11:00:00Z'); // segunda 08:00 BRT
  const to = new Date('2026-11-02T11:00:00Z');

  it('cabeçalho com @everyone, período e totais; um embed por tipo com os módulos e links', () => {
    const msgs = renderChangelog(groupChangelog([item('Filtro salvo', 'Feature', 'Report'), item('Erro X', 'Bug', 'Home')], TYPES, MODULES), from, to, true);
    assert.equal(msgs.length, 1);
    const m = msgs[0]!;
    assert.match(m.content!, /^@everyone\n## 📦 Changelog · 26\/10 a 02\/11\n\*\*2 entrega\(s\)\*\* em produção: 🚀 Feature \(1\) · 🐛 Bug \(1\)\n\*\*Manutenção por módulo\*\* \(melhorias \+ bugs\): 🏠 Home \(1\)$/);
    assert.deepEqual(m.embeds.map((e) => e.data.title), ['🚀 Feature · 1', '🐛 Bug · 1']);
    assert.equal(m.embeds[0]!.data.description, '**Report**\n• [Filtro salvo](https://app/c/Filtro salvo)');
  });

  it('semana grande: divide em embeds e mensagens dentro dos limites do Discord', () => {
    const many = Array.from({ length: 400 }, (_, i) => item(`Card com um título razoavelmente comprido número ${i}`, TYPES[i % 6]!, MODULES[i % 4]!));
    const msgs = renderChangelog(groupChangelog(many, TYPES, MODULES), from, to, true);
    assert.ok(msgs.length > 1);
    for (const m of msgs) {
      assert.ok(m.embeds.length <= 10);
      const size = m.embeds.reduce((n, e) => n + (e.data.title?.length ?? 0) + (e.data.description?.length ?? 0), 0);
      assert.ok(size <= 6000, `mensagem com ${size} caracteres`);
      for (const e of m.embeds) assert.ok(e.data.description!.length <= 4096);
    }
    const links = msgs.flatMap((m) => m.embeds).map((e) => e.data.description!.match(/^• /gm)?.length ?? 0).reduce((a, b) => a + b, 0);
    assert.equal(links, 400, 'nenhum card perdido na divisão');
    assert.equal(msgs.filter((m) => m.content?.includes('@everyone')).length, 1, '@everyone só na primeira');
  });

  it('manutenção por módulo: só melhorias + bugs, do maior para o menor, "sem módulo" por último', () => {
    const groups = groupChangelog(
      [
        item('a', 'Bug', 'Chat'),
        item('b', 'Melhoria', 'Board/Kanban'),
        item('c', 'Bug', 'Board/Kanban'),
        item('d', 'Feature', 'Chat'),
        item('e', 'Feature', 'Chat'),
        item('f', 'Bug', 'Sem módulo'),
        item('g', 'Bug', 'Sem módulo'),
        item('h', 'Melhoria', 'Dashboard'),
      ],
      TYPES,
      [...MODULES, 'Chat', 'Dashboard'],
    );
    assert.deepEqual(maintenanceByModule(groups), [
      { module: 'Board/Kanban', count: 2 },
      { module: 'Chat', count: 1 },
      { module: 'Dashboard', count: 1 },
      { module: 'Sem módulo', count: 2 },
    ]);
    const [m] = renderChangelog(groups, from, to, false);
    assert.ok(m!.content!.endsWith('📋 Board/Kanban (2) · 💬 Chat (1) · 📈 Dashboard (1) · 🧩 Sem módulo (2)'));
    assert.equal(moduleEmoji('Partner Portal'), '🤝');
    assert.equal(moduleEmoji('Portal'), '🌐');
  });

  it('período vazio', () => {
    const [m] = renderChangelog([], from, to, false);
    assert.match(m!.content!, /Nenhuma entrega/);
    assert.ok(!m!.content!.includes('@everyone'));
    assert.equal(periodLabel(from, to), '26/10 a 02/11');
  });
});

describe('agendamento: segunda 08:00 (Brasília)', () => {
  it('relógio de Brasília', () => {
    assert.deepEqual(brClock(new Date('2026-11-02T11:00:00Z')), { weekday: 1, minutes: 480, day: '2026-11-02' });
  });

  it('dispara segunda a partir das 08:00, uma vez por dia; período = 7 dias até 08:00', () => {
    assert.equal(dueWindow(new Date('2026-11-02T10:59:00Z'), undefined), undefined, '07:59 ainda não');
    const due = dueWindow(new Date('2026-11-02T13:30:00Z'), '2026-10-26'); // 10:30, bot voltou depois
    assert.deepEqual(due && [due.from.toISOString(), due.to.toISOString(), due.day], ['2026-10-26T11:00:00.000Z', '2026-11-02T11:00:00.000Z', '2026-11-02']);
    assert.equal(dueWindow(new Date('2026-11-02T13:30:00Z'), '2026-11-02'), undefined, 'já postou hoje');
    assert.equal(dueWindow(new Date('2026-11-03T11:00:00Z'), undefined), undefined, 'terça não');
  });
});

describe('coleta na Goalfy', () => {
  function fakeCtx() {
    const opened: string[] = [];
    const typeField = { fieldInfoId: 'f-tipo', name: 'Tipo', type: 'list', required: false, options: TYPES, index: 0 };
    const moduleField = { fieldInfoId: 'f-mod', name: 'Módulo/Funcionalidade', type: 'list', required: false, options: MODULES, index: 1 };
    const raw = (id: string, entered: string, tipo: string, mod?: string) => ({
      id,
      title: `Card ${id}`,
      phasesHistory: [{ createdAt: entered, phase: { id: 'prod' }, form: {} }],
      form: { id: 'F', fields: [{ infoId: 'f-tipo', value: tipo }, ...(mod ? [{ infoId: 'f-mod', value: mod }] : [])] },
    });
    const db: Record<string, unknown> = {
      novo: raw('novo', '2026-10-28T13:00:00.000', 'Bug', 'Report'),
      antigo: raw('antigo', '2026-09-01T13:00:00.000', 'Feature', 'Home'),
      semmodulo: raw('semmodulo', '2026-10-30T13:00:00.000', 'Melhoria'),
    };
    const ctx = {
      store: new Store(':memory:'),
      board: {
        phases: async () => [
          { id: 'dev', title: 'Em Desenvolvimento', index: 0, archived: false },
          { id: 'prod', title: 'Em Produção', index: 1, archived: false, done: true },
          { id: 'cancel', title: 'Cancelado/Arquivado', index: 2, archived: false, done: true },
        ],
        isDone: (p: { done?: boolean }) => !!p.done,
        isCancel: (p: { title: string }) => /cancel/i.test(p.title),
        createForm: async () => ({ fields: { type: typeField, module: moduleField } }),
        cardUrl: (id: string) => `https://app/board/B/cards/${id}`,
      },
      goalfy: {
        listCardsByPhase: async (phaseId: string) => (phaseId === 'prod' ? Object.keys(db).map((id) => ({ id, title: `Card ${id}` })) : phaseId === 'cancel' ? [{ id: 'cancelado', title: 'x' }] : []),
      },
      cards: {
        get: async (id: string) => {
          opened.push(id);
          return toCard(db[id])!;
        },
      },
    } as unknown as BotContext;
    return { ctx, opened };
  }

  it('só entra o que chegou em produção no período (cancelados fora), por tipo e módulo', async () => {
    const { ctx } = fakeCtx();
    const groups = await collectChangelog(ctx, new Date('2026-10-26T11:00:00Z'), new Date('2026-11-02T11:00:00Z'));
    assert.deepEqual(
      groups.map((g) => [g.type, g.modules.map((m) => [m.module, m.items.map((i) => i.url)])]),
      [
        ['Melhoria', [['Sem módulo', ['https://app/board/B/cards/semmodulo']]]],
        ['Bug', [['Report', ['https://app/board/B/cards/novo']]]],
      ],
    );
  });

  it('na semana seguinte não reabre cards já vistos (só os do período, para o título atual)', async () => {
    const { ctx, opened } = fakeCtx();
    await collectChangelog(ctx, new Date('2026-10-26T11:00:00Z'), new Date('2026-11-02T11:00:00Z'));
    opened.length = 0;
    await collectChangelog(ctx, new Date('2026-11-02T11:00:00Z'), new Date('2026-11-09T11:00:00Z'));
    assert.deepEqual(opened, [], 'nenhum card aberto: datas já estavam no banco e nenhum caiu no período');
  });
});
