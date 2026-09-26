# Goalfy Discord Bot

Bot que liga o **canal de N2/N3 no Discord** ao **board de backlog na Goalfy**, seguindo o
[processo de N2/N3, Sustentação e Gestão de Demandas](notion.md):

> **Discord é onde investigamos e conversamos. Goalfy é onde gerenciamos o trabalho.**

Este README é para devs que conhecem Node/TypeScript, HTTP e bancos de dados, mas **nunca
trabalharam com um bot de Discord**. A seção 2 explica o mínimo de Discord necessário para
entender o código. Se você já conhece discord.js, pule para a [seção 3](#3-arquitetura).

**Sumário**

1. [O que o bot faz](#1-o-que-o-bot-faz)
2. [Discord para quem nunca fez um bot](#2-discord-para-quem-nunca-fez-um-bot)
3. [Arquitetura](#3-arquitetura)
4. [Rodando localmente](#4-rodando-localmente)
5. [Estrutura do código e como estender](#5-estrutura-do-código-e-como-estender)
6. [Integração com a Goalfy](#6-integração-com-a-goalfy)
7. [Testes](#7-testes)
8. [Deploy](#8-deploy)
9. [Problemas comuns](#9-problemas-comuns)

---

## 1. O que o bot faz

```
Tópico aberto no fórum N2/N3
   │  bot marca 🔎 Em Triagem, aponta o que falta no relato e sugere cards parecidos
   ▼
Painel da triagem (só quem tem o cargo de N2/N3)
   ├─ 📋 Criar card ──► selects do Formulário Inicial ──► modal com os textos ──► card na Goalfy
   ├─ 🔗 Vincular card existente (duplicidade)
   ├─ ⏳ Pedir informação  ──► marca o solicitante; quando ele responde, volta para 🔎
   ├─ ✅ Resolvido sem card ──► registra como foi resolvido e arquiva o tópico
   └─ ❌ Não procede        ──► registra o motivo e arquiva o tópico
   ▼
Card vinculado (📋 Card Criado)
   │  o card leva o link do tópico e o tópico fica com o card fixado
   │  mudanças de fase e comentários feitos na Goalfy aparecem no tópico
   ▼
Card chega na fase final ──► ✅ Resolvido (entrega) ou ❌ Não procede (cancelado/arquivado, com o motivo);
                             o solicitante é marcado e o tópico é arquivado
```

**Comandos**

| Comando | O que faz | Quem pode usar |
| --- | --- | --- |
| `/card criar` | Cria um card (dentro de um tópico, já vincula) | Triagem |
| `/card listar [fase] [busca] [publico]` | Lista cards paginados, com seletor para ver detalhes | Todos |
| `/card ver [card]` | Detalhes do card, com os botões Abrir, Mover e Atualizar | Todos |
| `/card mover fase [card]` | Move o card de fase | Triagem |
| `/card comentar texto [card]` | Comenta no card | Todos |
| `/card vincular card` | Vincula o tópico a um card que já existe | Triagem |
| `/triagem pendentes` | Tópicos ainda sem destino (regra 8 do processo) | Todos |
| `/triagem relatorio [dias]` | Indicadores: abertos, cards gerados, resolvidos na triagem, tempo até destino, contagem por frente, tipo, origem e severidade | Todos |
| `/triagem painel` | Reenvia o painel no tópico (útil para tópicos antigos) | Triagem |
| `/goalfy status` | Diagnóstico: fases, formulário e campos mapeados | Admin do servidor |
| Menu da mensagem → **Enviar ao card Goalfy** | Manda uma mensagem do tópico como comentário no card | Todos |

Nos comandos, `card` aceita ID, `#ID`, o link do card ou uma busca pelo título (com autocomplete).
Dentro de um tópico vinculado, você pode omitir o card.

---

## 2. Discord para quem nunca fez um bot

### 2.1 Aplicação, bot e token

No [Developer Portal](https://discord.com/developers/applications) você cria uma **Application**.
Ela é o equivalente a um *client* OAuth. Dentro dela existe o **Bot**, uma conta de serviço com um
**token** próprio. O token é uma credencial de produção: quem o tiver controla o bot. Guarde-o em
segredo, como qualquer outra chave de API.

Para o bot entrar num servidor, você gera uma **URL de convite** com os *scopes* (`bot`,
`applications.commands`) e as permissões desejadas. Um admin do servidor abre a URL e autoriza.

### 2.2 Gateway (WebSocket) × REST

Um bot de Discord **não é um endpoint HTTP que recebe chamadas**. Ele é um **processo de longa
duração** que:

- abre uma conexão **WebSocket** com o *Gateway* do Discord e recebe eventos por *push*
  (mensagem criada, tópico criado, clique num botão…). Pense num consumidor de fila;
- usa a **API REST** do Discord para agir (enviar mensagem, trocar tags, arquivar tópico).

A biblioteca [discord.js](https://discord.js.org) cuida dos dois lados. Você registra *handlers*
(`client.on(Events.X, fn)`), e ela mantém a conexão, faz reconexão e respeita os *rate limits*
automaticamente.

> Consequência prática: **rode só uma instância do bot**. Duas instâncias conectadas com o mesmo
> token recebem os mesmos eventos e respondem em dobro.

### 2.3 Intents

Ao conectar, o bot declara quais **intents** (categorias de eventos) quer receber. Isso funciona
como uma assinatura de tópicos. Este bot usa três:

| Intent | Para quê |
| --- | --- |
| `Guilds` | Canais, tópicos e cargos do servidor (inclui o evento "tópico criado") |
| `GuildMessages` | Saber quando alguém responde num tópico |
| `MessageContent` ⚠️ | **Ler o texto** das mensagens (a mensagem inicial do tópico) |

`MessageContent` é **privilegiado**: sem ativá-lo em *Bot → Privileged Gateway Intents*, os
eventos chegam, mas `message.content` vem vazio. Ativar é um clique, e bots em menos de 100
servidores não precisam de aprovação.

### 2.4 Vocabulário

| Discord | O que é | No código |
| --- | --- | --- |
| **Guild** | Um servidor (o da empresa) | `DISCORD_GUILD_ID` |
| **Canal de fórum** | Canal em que cada post vira um tópico | `DISCORD_FORUM_CHANNEL_IDS` |
| **Thread / tópico** | Uma conversa dentro do fórum; tem dono (`ownerId`), pode ser arquivada | `AnyThreadChannel` |
| **Tags do fórum** | Etiquetas configuradas no fórum; cada tópico pode ter até 5 | status do tópico |
| **Role** | Cargo; usado para permissões | `DISCORD_TRIAGE_ROLE_IDS` |
| **Snowflake** | Formato dos IDs do Discord (string numérica) | todos os `*_ID` |
| **Embed** | Mensagem "cartão", com título, campos e cor | `EmbedBuilder` |

Para copiar IDs no Discord, ative *Configurações → Avançado → Modo desenvolvedor* e depois use
clique direito → **Copiar ID** no servidor, canal ou cargo.

### 2.5 Interactions: comandos, botões e modais

Tudo que o usuário "aciona" chega como uma **Interaction**:

- **Slash commands** (`/card listar`) são declarados com um *schema* (nome, opções, tipos) e
  **registrados via REST** antes de aparecerem no Discord. É para isso que existe
  `npm run deploy-commands`. Pense numa migration: rode sempre que mudar a definição dos comandos.
- **Componentes** (botões e selects) são anexados às mensagens. Cada um tem um **`customId`**,
  uma string de até 100 caracteres que volta para o bot quando alguém clica. Aqui ela funciona
  como uma rota: `card:move:12345` significa escopo `card`, ação `move`, argumento `12345`.
- **Modais** são formulários em popup (campos de texto e selects) e também têm `customId`.
- **Autocomplete** é a sugestão enquanto o usuário digita uma opção do comando (ex.: fases do
  board).

**Regras que moldam o código:**

1. **Toda interaction precisa de resposta em até 3 segundos**, senão o usuário vê "A interação
   falhou". Quando o trabalho é lento (chamar a Goalfy, por exemplo), o bot responde na hora com
   `deferReply()`/`deferUpdate()` ("pensando…") e depois completa com `editReply()`. Por isso
   quase todo handler começa com `defer`.
2. **Modal só pode ser a primeira resposta** de uma interaction. Não dá para dar `defer` e depois
   abrir um modal. Por isso, os handlers que abrem modal não chamam a Goalfy antes.
3. Respostas podem ser **efêmeras** (`MessageFlags.Ephemeral`): só quem clicou vê. O bot usa isso
   para mensagens de confirmação e erro, e para passos intermediários.

### 2.6 Permissões do bot

O bot só consegue fazer o que o cargo dele permite no canal. Este bot precisa de:

View Channels · Send Messages · Send Messages in Threads · Embed Links · Read Message History ·
Add Reactions · **Manage Threads** (trocar tags e arquivar) · **Pin Messages** (fixar o card no tópico)

URL de convite com exatamente essas permissões (troque `CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=2252091871546432
```

---

## 3. Arquitetura

```
                ┌───────────────────────── Discord ─────────────────────────┐
                │  Gateway (WebSocket)                 REST API              │
                └──────┬──────────────────────────────────▲─────────────────┘
      eventos: tópico  │                                  │ enviar mensagem, tags,
      criado, clique,  │                                  │ arquivar, fixar…
      modal enviado    ▼                                  │
                ┌───────────────────────── Bot (Node) ──────────────────────┐
                │ index.ts ── roteia eventos e interactions por customId     │
                │   ├─ discord/triage.ts   painel, classificação, status     │
                │   ├─ discord/commands.ts /card, /triagem, /goalfy          │
                │   └─ discord/sync.ts     Goalfy → Discord (fases, comentários)
                │ goalfy/*   cliente REST + normalização + regras do board   │
                │ store.ts   SQLite (vínculo tópico↔card, status, métricas)  │
                │ webhook.ts servidor HTTP opcional para eventos da Goalfy   │
                └──────┬───────────────────────────────────▲────────────────┘
                       │ REST (Authorization: Token …)     │ POST MOVE_CARD_TO
                       ▼                                   │ (webhook, opcional)
                ┌──────────────────────────── Goalfy ───────────────────────┐
                │ api.goalfy.com.br/api                                      │
                └────────────────────────────────────────────────────────────┘
```

**Decisões e por quês**

| Decisão | Motivo |
| --- | --- |
| **SQLite** via `node:sqlite` (nativo do Node 22+) | Poucos dados (vínculos, status, métricas), uma instância só, zero dependência nativa para compilar |
| **Webhook + polling** | A Goalfy avisa mudanças de fase por webhook (tempo real), mas **não tem evento para comentários**. O polling (a cada `SYNC_INTERVAL_SECONDS`) sincroniza comentários e cobre webhooks perdidos |
| **Lock por card** (`syncCard`) | Webhook, polling e o comando `/card mover` podem processar o mesmo card ao mesmo tempo; o lock evita anunciar a mesma mudança duas vezes |
| **Normalizadores tolerantes** (`goalfy/types.ts`) | Os exemplos da documentação pública da Goalfy diferem das respostas reais (ver [6.3](#63-divergências-entre-a-documentação-pública-e-a-api-real)) |
| **Formulário dirigido pela Goalfy** (`goalfy/formPlan.ts`) | O bot lê o Formulário Inicial e os formulários de fase do board (`GET /models/{id}`) e monta selects e modais a partir deles. Mudou um campo na Goalfy? O bot acompanha, sem deploy |
| **Regras do processo em um arquivo só** (`process.ts`) | Status do tópico, sugestões (ex.: tag "Major" → severidade) e padrões de nome mudam com o processo, não com o código |
| **Estado em memória só para rascunhos** | A classificação entre o passo 1 e o passo 2 da criação vive num `Map` por 30 min; perder isso num restart custa um clique |

### Fluxo: criar um card

```
Triagem clica "📋 Criar card"
  → bot lê o Formulário Inicial e monta o plano (formPlan.planCreate):       [triage.startCardFlow]
       até 4 campos de seleção viram selects; textos vão para o modal
  → selects já vêm marcados pelo tópico: tags do fórum ("Major", "Regressão")
    e o "Origem: …" do modelo de abertura                                    [triage.suggestSelects]
  → "Continuar" abre o modal: título + campos de texto, pré-preenchidos       [triage.onClassifyNext]
  → envio do modal:                                                           [triage.onCreateModal]
       POST /cards/form  (Formulário Inicial do board)
       PUT  /cards/{id}  (título)
       POST /external/v1/cards/{id}/comments (origem + o que não coube em campos)
       grava o vínculo no SQLite, troca a tag para 📋 e fixa o card no tópico
```

### Fluxo: um dev move o card na Goalfy

```
Goalfy ──POST webhook──► webhook.ts ──► syncCard(cardId)   ┐
polling a cada N s ─────────────────► syncCard(cardId)     ├─ lock por card
/card mover ────────────────────────► syncCard(cardId)     ┘
    → GET /cards/{id}; se a fase mudou: mensagem no tópico, tag da fase e,
      se for a fase final, tag ✅ Resolvido (ou ❌ se for cancelamento) e tópico arquivado
```

### Fluxo: mover pelo Discord respeitando os formulários de fase

```
"Mover fase" → escolhe a fase                                              [move.requestMove]
  → avançando? os obrigatórios da fase ATUAL precisam estar preenchidos
    (ex.: "Mapa para Testes" em Desenvolvido); lidos de card.phasesHistory
  → fase final? os obrigatórios DELA vão junto (ex.: "Motivo do arquivamento")
  → falta algo: botão "📝 Preencher e mover" → modal com esses campos        [move.onFillAndMove]
       POST /forms/{formId}/field/ (ou PUT /forms/field/{id}) na fase atual
       PUT /cards/moveTo/{id}  ou  POST /cards/moveToDonePhase/{id} com os campos
  → campo que o bot não sabe coletar (ex.: anexo obrigatório): orienta a mover pela Goalfy
```

---

## 4. Rodando localmente

Pré-requisitos: **Node 22.13+** (testado no 24) e acesso de admin a um servidor de Discord. Crie
um servidor pessoal para testar, isso leva 10 segundos.

### 4.1 Criar a aplicação no Discord

1. Em <https://discord.com/developers/applications>, clique em **New Application**.
2. Copie o **Application ID** (vai em `DISCORD_CLIENT_ID`).
3. Em **Bot**, clique em **Reset Token** e copie o token (vai em `DISCORD_TOKEN`).
4. Ainda em **Bot**, ligue **Message Content Intent**.
5. Abra a URL de convite da [seção 2.6](#26-permissões-do-bot) com o seu `CLIENT_ID` e adicione o
   bot ao servidor.

### 4.2 Preparar o servidor

1. Crie um **canal de fórum** (ex.: `#n2-n3`).
2. Nas configurações do fórum, crie as **tags de status** com estes nomes (emoji opcional):
   `Em Triagem` · `Aguardando Informação` · `Card Criado` · `Resolvido` · `Não Procede`

   **Fórum que já existe com outras tags?** Não precisa renomear nada. Aponte cada status para
   uma tag existente, ou desligue o status, em `DISCORD_STATUS_TAGS`, por exemplo:
   `triage=Pendente;waiting=;card=;resolved=Resolvido;rejected=`. Status sem tag mapeada não
   mexe nas tags do tópico (o bot só posta a mensagem e registra nas métricas). As tags que o
   solicitante escolhe (ex.: `Major`, `Regressão`) nunca são removidas e servem para pré-selecionar
   Severidade e Tipo (`SEVERITY_TAGS` em [src/process.ts](src/process.ts)).
3. Opcional: crie tags de tipo (`Bug`, `Regressão`, `Melhoria`…) para o bot pré-selecionar o tipo.
   Tags com o **mesmo nome das fases do board** também funcionam: o bot mantém no tópico a tag da
   fase atual.
4. Crie o cargo da triagem N2/N3 (ex.: `@Triagem`) e atribua a quem faz a triagem.

### 4.3 Preparar a Goalfy

1. Gere um token em <https://app.goalfy.com.br/settings/0> → **Gerar Chave**.
   - O token age **como o usuário que o gerou**: esse usuário precisa ser membro do board, e os
     comentários do bot aparecem no nome dele. O ideal é criar um usuário dedicado (ex.: "Bot
     Discord").
2. Descubra IDs e confira o mapeamento de campos:

```bash
cp .env.example .env                  # preencha GOALFY_TOKEN
npm install
npm run discover                      # lista os boards do token
npm run discover -- <boardId>         # fases, formulários e mapeamento de campos detectado
npm run discover -- <boardId> --raw   # + respostas cruas da API
```

**Não existe lista fixa de campos.** O bot lê o Formulário Inicial do board e pergunta o que ele
pede: campos de seleção (até 4) viram selects no passo 1, e textos vão para o modal do passo 2. O
`discover` mostra exatamente esse plano e as fases que exigem campos antes de mover:

```
O que o bot vai perguntar ao criar um card (* = obrigatório):
  Passo 1 (selects):
    • Origem * [Suporte | Consultoria | …]
    • Tipo * [Bug | Melhoria | …]
    • Módulo/Funcionalidade * [Board/Kanban | …]
    • Prioridade especial * [Nenhuma | Atenção Especial | Major]
  Passo 2 (modal):
    • Título do card * → também preenche "Título da tarefa"
    • Descrição *
    • Link do figma (dev)
    • Link RFC
  Não perguntado (opcional): Anexo

Fases com campos obrigatórios (o bot pede antes de mover):
  • Desenvolvido (antes de avançar): Mapa para Testes *
  • Cancelado/Arquivado (ao entrar): Motivo do arquivamento *
```

Alguns campos têm papel especial, detectado pelo nome: **título** (recebe o título do card),
**descrição** (pré-preenchida com o texto do tópico) e **link do Discord / solicitante**
(preenchidos automaticamente, sem perguntar). Se o nome não for reconhecido, aponte o ID em
`GOALFY_FIELD_*`. Se não existir campo para o link do tópico, ele vai num comentário do card.

Valores de seleção são casados com as opções do campo ("S2 — Alto" encontra "S2 - Alto"). Se o
formulário tiver um **obrigatório que o bot não consegue coletar** (ex.: anexo), o `discover` e o
`/goalfy status` avisam.

### 4.4 Configurar e subir

Preencha o `.env` (cada variável está comentada em [.env.example](.env.example)) e rode:

```bash
npm run deploy-commands   # registra os slash commands no servidor (repita quando mudar comandos)
npm run dev               # sobe o bot com reload automático
```

No log deve aparecer `Conectado como <bot>` e a lista de fases do board. Abra um tópico no fórum
para ver o painel da triagem.

### 4.5 Testando o webhook localmente (opcional)

A Goalfy precisa alcançar o bot por HTTPS. Em desenvolvimento, use um túnel:

```bash
cloudflared tunnel --url http://localhost:3000     # ou: ngrok http 3000
# WEBHOOK_PUBLIC_URL=https://<endereço-do-túnel>
```

Ao subir, o bot registra o hook no board e guarda o ID no SQLite. Nos restarts seguintes com a
mesma URL, ele reaproveita o hook em vez de criar outro.

---

## 5. Estrutura do código e como estender

```
src/
  index.ts              bootstrap: cliente Discord, roteamento de eventos e interactions
  config.ts             .env validado com zod (falha cedo, com mensagem clara)
  context.ts            BotContext: dependências passadas para os handlers (sem singletons globais)
  process.ts            ★ regras do processo N2/N3: tipos, frentes, severidades, status
  topicTemplate.ts      leitura do modelo de abertura de tópico (seção 11 do processo)
  store.ts              SQLite: vínculos, status dos tópicos, comentários vistos, chave-valor
  webhook.ts            servidor HTTP + registro do webhook na Goalfy
  goalfy/
    client.ts           chamadas REST (auth, timeout, retry em 429/5xx sem repetir POST)
    types.ts            normalização das respostas → tipos do bot (Card, Phase, Comment…)
    board.ts            fases e formulários do board (cache de 5 min), busca paginada
    formPlan.ts         como coletar cada campo no Discord (selects, modal, limites) e regras de fase
    cards.ts            criar card, gravar campos de fase e mover
  discord/
    ui.ts               embeds, botões, selects, modais e a tabela de customIds (IDS)
    triage.ts           painel da triagem, criação de card em 2 passos, status do tópico
    commands.ts         definição dos slash commands + handlers + autocomplete
    move.ts             mover card pedindo os campos obrigatórios de fase
    setup.ts            diagnóstico do servidor e registro automático dos comandos
    topics.ts           tags de status/fase do tópico, permissão da triagem
    sync.ts             sincronização Goalfy → Discord e lembrete de tópicos parados
  scripts/
    deploy-commands.ts  registra os comandos no servidor
    discover.ts         inspeciona o board na Goalfy
test/                   node:test (roda com `npm test`)
```

### Receita: adicionar um botão

1. Declare o ID em `IDS` ([src/discord/ui.ts](src/discord/ui.ts)):
   ```ts
   archive: (cardId: string) => `card:archive:${cardId}`,
   ```
2. Crie o botão com `.setCustomId(IDS.archive(id))` e anexe a uma mensagem.
3. Trate a ação em `onCardButton` ([src/discord/commands.ts](src/discord/commands.ts)). O
   roteador em [src/index.ts](src/index.ts) já envia `card:*` para lá, com `action` e `arg`
   separados pelo `:`.
4. Se a ação demora, comece com `await interaction.deferUpdate()` ou `deferReply()` (regra dos 3 s).
5. Se só a triagem pode usar, comece com `if (!(await requireTriage(ctx, interaction))) return;`.

### Receita: adicionar um subcomando

1. Adicione o `.addSubcommand(...)` no builder em [src/discord/commands.ts](src/discord/commands.ts).
2. Trate o caso no `handleCard`/`handleTriage`. Exceções lançadas ali viram uma mensagem de erro
   amigável automaticamente (`onChatInput`).
3. Rode `npm run deploy-commands`. Sem isso, o Discord não conhece o comando novo.

### Receita: mudar o processo

Tipos, frentes, origens, severidades, nomes dos status e nomes de campos ficam em
[src/process.ts](src/process.ts). As seções do modelo de abertura ficam em
[src/topicTemplate.ts](src/topicTemplate.ts). Mudou o nome de uma tag de status? Renomeie no fórum
**e** em `TOPIC_STATUS`.

---

## 6. Integração com a Goalfy

### 6.1 Autenticação

`Authorization: Token <GOALFY_TOKEN>` em todas as chamadas para `https://api.goalfy.com.br/api`.
O token age como o usuário que o gerou (ver [4.3](#43-preparar-a-goalfy)).

### 6.2 Endpoints usados

| Uso | Endpoint |
| --- | --- |
| Fases do board | `GET /phases/board/{boardId}` |
| Formulários do board (acha o Formulário Inicial) | `GET /boards/{boardId}/fields` |
| Formulário completo (obrigatórios, opções, ajuda) | `GET /models/{modelId}` |
| Gravar campo da fase atual | `POST /forms/{formId}/field/` `{ fieldInfoId, value, cardId }`, `PUT /forms/field/{fieldId}` `{ value }` |
| Buscar/listar cards | `GET /cards/board/{boardId}/filter?limit&offset&search` |
| Cards de uma fase | `GET /cards/phase/{phaseId}` |
| Ler card | `GET /cards/{id}` |
| Criar card | `POST /cards/form` `{ modelId, fields: [{ fieldInfoId, value }] }` |
| Título | `PUT /cards/{id}` `{ title }` |
| Mover | `PUT /cards/moveTo/{id}` `{ phaseId }` |
| Mover para fase final | `POST /cards/moveToDonePhase/{id}` `{ modelId, phaseId, fields }` |
| Comentários | `GET /cards/{id}/comments`, `POST /external/v1/cards/{id}/comments` `{ body }` |
| Webhook | `POST /external/v1/boards/{boardId}/hook` `{ event: "MOVE_CARD_TO", hookUrl }`, `DELETE …/hook/{hookId}` |

### 6.3 Divergências entre a documentação pública e a API real

Estas diferenças foram confirmadas no código do `goalfy-service` e já estão tratadas no bot. Vale
saber delas caso você use a API em outro lugar:

| Assunto | Documentação pública | Comportamento real |
| --- | --- | --- |
| `offset` do filtro de cards | "página, começa em 1" | **Índice de página começando em 0** (`Page.of(offset, limit)`). `offset=1` pula a primeira página |
| Campos do board | `GET /{boardId}/fields` | **`GET /boards/{boardId}/fields`** |
| Formato dos campos | `[{ phaseId, phaseName, fields: [{ fieldInfoId, name, type }] }]` | `[{ id, name, fields: [{ id, title, fieldType, options }] }]`. O **1º item é o "Formulário Inicial"**, cujo `id` é o `modelId` de criação de cards |
| Formulário de criação | não explica qual `modelId` usar | É o **Formulário Inicial do board**, e não o formulário da 1ª fase |
| Fase final | não documentado | Fases têm o flag `done: true` |
| Obrigatórios do formulário | — | `/boards/{id}/fields` não traz; use `GET /models/{modelId}` (`required`, `helpText`, `options`). Lá o rótulo fica em `title` (`name` é um id interno como `fieldTítulo`) |
| Campos por fase do card | — | `GET /cards/{id}` → `phasesHistory[]` com `{ phase, form: { id, fields: [{ id, infoId, value }] } }` |
| Obrigatórios ao mover | — | A regra "preencher os obrigatórios da fase atual antes de avançar" existe no backend, mas está **comentada** (`MoveCardToPhaseImpl`): a API não barra. O bot aplica a regra por conta própria |
| Fase do card nas listagens | `"phase": "Em andamento"` | Só `phaseId`. O nome vem de `/phases/board` |
| Tags do card | — | `{ id, text, color }` (o nome fica em `text`) |
| Total da busca | — | `{ cards: [...], cardsCount: <total> }` |
| Datas | ISO com `Z` | `yyyy-MM-ddTHH:mm:ss.SSS` **em UTC sem sufixo**. Sem tratar, o JS lê como horário local |
| Valores de campos | — | `singleSelect` → string, `checkbox` → `string[]` |
| Webhooks | não documentados | Assinatura por board/evento; o payload **não é assinado** (por isso o segredo na URL, e o bot relê o card na API em vez de confiar no payload) |

---

## 7. Testes

```bash
npm test          # node:test + tsx, sem Discord nem Goalfy de verdade
npm run typecheck
```

Os testes usam os **formatos reais** das respostas da Goalfy (seção 6.3) e cobrem:

- normalização (datas UTC, tags, comentários Draft.js);
- escolha do Formulário Inicial, flag `done` e paginação 0-based;
- casamento de valores com as opções dos campos;
- leitura do modelo de abertura de tópico;
- indicadores do SQLite;
- webhook: segredo, deduplicação de avisos simultâneos e reaproveitamento do hook no restart.

O que **não** está coberto por teste automatizado é a interação com o Discord (modais, botões,
permissões). Para isso, use um servidor de teste (seção 4).

---

## 8. Deploy

```bash
docker compose up -d --build                     # só o bot (polling)
docker compose --profile webhook up -d --build   # bot + Caddy com HTTPS automático para o webhook
docker compose run --rm bot node dist/scripts/deploy-commands.js
docker compose logs -f bot
```

- **Uma réplica só** (ver 2.2). Em Kubernetes, use `replicas: 1` e estratégia `Recreate`.
- **Volume em `/app/data`**: o SQLite guarda os vínculos tópico↔card. Sem volume, um restart
  perde o acompanhamento dos cards.
- **Webhook**: exponha a porta `3000` atrás de HTTPS e defina `WEBHOOK_PUBLIC_URL`. `GET /health`
  responde `ok` para health checks. Sem webhook, o bot funciona só com polling.
- Não é preciso abrir porta para o Discord: a conexão com o Gateway sai do bot.

---

## 9. Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| Os comandos `/card`… não aparecem | Faltou `npm run deploy-commands`, ou o `DISCORD_GUILD_ID` está errado. Reabra o Discord (Ctrl+R) |
| "A interação falhou" | O handler demorou mais de 3 s sem `defer`, ou o bot estava offline. Veja o log |
| O painel não aparece em tópicos novos | O fórum não está em `DISCORD_FORUM_CHANNEL_IDS`, ou falta a permissão Send Messages in Threads |
| O formulário vem sem o texto do tópico | **Message Content Intent** desligado no portal |
| As tags não mudam | Falta **Manage Threads** para o bot, ou o nome da tag no fórum não bate com `TOPIC_STATUS` |
| Erro `Used disallowed intents` ao iniciar | Message Content Intent desligado no portal |
| Goalfy 401 | Token inválido ou revogado |
| Goalfy 403 / "BoardAccessNotAllowed" | O usuário do token não é membro do board |
| Card criado sem alguns campos | Veja `/goalfy status` → "Campos do formulário sem mapeamento" e defina `GOALFY_FIELD_*` |
| Mudança de fase demora a aparecer | Sem webhook, depende do `SYNC_INTERVAL_SECONDS`. Com webhook, confira no log se o hook foi registrado |

Para mais detalhes no log, use `LOG_LEVEL=debug`.

## Limitações conhecidas

- Links de anexos do Discord expiram. O card guarda o link do tópico, onde as evidências continuam.
- Um card movido para fora da fase final depois de concluído não reabre o acompanhamento. Use
  `/card vincular` num tópico novo, se precisar.
- Os comentários só sincronizam por polling, porque a Goalfy não emite evento para comentários.
