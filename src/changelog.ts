/**
 * Novidades do bot, anunciadas no canal DISCORD_UPDATES_CHANNEL_ID (modo de uso, para o time).
 *
 * Ao lançar algo que muda o uso: adicione uma entrada NO TOPO com um `id` novo. No próximo
 * deploy o bot posta as entradas que ainda não postou (o controle fica no banco) — uma vez só.
 * Escreva para quem usa (suporte/triagem), não para dev: o que mudou e como usar.
 */
export interface ChangelogEntry {
  /** Único e estável (ex.: data + assunto). Trocar o id faz a entrada ser postada de novo. */
  id: string;
  title: string;
  /** Linhas do modo de uso (markdown do Discord). */
  body: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-10-21-painel-identificacao-parecidos',
    title: '📝 Abertura de tópico: identificação do chamado e cards parecidos',
    body: [
      'Ao abrir um tópico no fórum de N2, comece a descrição pelo bloco:',
      '> **Org:** nome da organização\n> **Usuário:** quem relatou\n> **Link do board + relatório:** https://app.goalfy.com.br/board/…',
      'Se faltar algum desses itens (ou o print/vídeo), o bot marca quem abriu e mostra o que faltou. É só responder no próprio tópico.',
      '',
      '**Cards parecidos:** se já existir card com o mesmo assunto, o painel mostra o card, a fase (avisa se **já está em produção**) e um botão **🔗 Vincular: <card>** — a triagem vincula com um clique e o tópico passa a acompanhar o card.',
    ],
  },
  {
    id: '2026-10-20-topicos',
    title: '🧵 Novo comando: /topicos',
    body: [
      'Digite **`/topicos`** em qualquer canal para ver os tópicos que **você** abriu no fórum de N2 — só você vê a resposta.',
      'Cada linha mostra o status, a **fase do card na Goalfy** (clique para abrir o card), as etiquetas e se o tópico ainda está **💬 sem resposta**.',
      'Use os botões para filtrar: **Em aberto** · **Sem resposta** · **Com card** · **Encerrados** · **Todos**.',
      'Para ver os de outra pessoa: `/topicos usuario:@pessoa`.',
    ],
  },
  {
    id: '2026-10-20-mencoes',
    title: '🔔 Menções da Goalfy chegam no Discord',
    body: [
      'Quando alguém **mencionar você num comentário do card na Goalfy**, o comentário aparece no tópico vinculado já **marcando você no Discord** (você recebe a notificação).',
      'Para funcionar, seu nome no Discord precisa ser igual ao da Goalfy (ou seu usuário do Discord igual ao começo do seu e-mail). Se não reconhecer, aparece só "@Seu Nome", sem notificar.',
    ],
  },
  {
    id: '2026-10-19-anexar-ao-card',
    title: '📎 Prints e vídeos vão para o card',
    body: [
      'As imagens e arquivos da abertura do tópico vão automaticamente para o campo **Anexo** do card quando ele é criado (o link do Discord expira; o anexo na Goalfy não).',
      'Mandou um print depois? Clique com o botão direito na mensagem → **Apps** → **Anexar ao card Goalfy**. Para mandar a mensagem como comentário (com os anexos), use **Enviar ao card Goalfy**.',
    ],
  },
];
