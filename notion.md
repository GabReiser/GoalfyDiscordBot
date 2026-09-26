# Processo de N2/N3, Sustentação e Gestão de Demandas

## 🎯 Objetivo

Criar um fluxo único para ocorrências técnicas vindas de **Suporte, Consultoria, Produto ou equipe interna**, preservando:

- **Discord** como canal de comunicação, investigação e troca de contexto.
- **Goalfy** como fonte oficial para gestão, priorização e acompanhamento do trabalho.

> **Discord é onde investigamos e conversamos. Goalfy é onde gerenciamos o trabalho.**
> 

---

# 1. Estrutura da Equipe de Produto

A Equipe de Produto trabalha em três grandes frentes:

| Frente | Missão | Exemplos |
| --- | --- | --- |
| 🛠️ **Sustentação** | Manter a operação saudável e corrigir problemas do produto existente | Bugs, regressões, incidentes, N2/N3, correções |
| 🏗️ **Engenharia** | Evoluir a base tecnológica para suportar o crescimento | Arquitetura, performance, observabilidade, segurança, infraestrutura, escala e dívida técnica |
| 🚀 **Produto** | Evoluir funcionalidades e gerar valor para clientes e estratégia | Features, melhorias funcionais, CRM, IA Studio, Cadência, Omni, CPQ etc. |

> As frentes representam **responsabilidades e alocação de capacidade**, e não cargos ou times isolados.
> 

---

# 2. Princípios do Processo

1. Nem todo tópico de N2/N3 precisa virar card.
2. Todo tópico que gerar trabalho de **Sustentação, Engenharia ou Produto** deve estar registrado na Goalfy.
3. Criar um card **não significa assumir prazo ou compromisso de entrega**.
4. A origem da demanda não determina sua frente.
5. A classificação acontece durante a triagem.
6. Nenhum tópico de N2/N3 deve ficar sem destino.
7. A urgência informada por quem solicitou é uma informação importante, mas **não determina automaticamente a prioridade**.

---

# 3. Canais de Entrada

Uma ocorrência pode nascer em diferentes áreas, mas todas seguem o mesmo processo quando precisam de análise técnica.

### Suporte / Cliente

O N1 registra e acompanha o atendimento no board de tickets do Suporte.

Quando identifica necessidade de análise técnica, abre um tópico no canal N2/N3 do Discord.

### Consultoria

Pode abrir diretamente um tópico no Discord quando identificar um possível problema durante implantação, configuração ou utilização da plataforma.

### Produto / Equipe interna

Ao identificar bugs ou comportamentos suspeitos utilizando a própria plataforma, abre diretamente um tópico no Discord.

### Outras áreas

Podem utilizar o mesmo canal quando identificarem uma ocorrência técnica.

---

# 4. Fluxo Geral

```
CLIENTE
   ↓
SUPORTE N1 ─────────┐
                    │
CONSULTORIA ────────┤
                    │
EQUIPE INTERNA ─────┼──→ DISCORD N2/N3
                    │           ↓
PRODUTO ────────────┤      TRIAGEM N2/N3
                    │           ↓
OUTRAS ÁREAS ───────┘    DIAGNÓSTICO INICIAL
                                ↓
                 ┌──────────────┼───────────────┐
                 ↓              ↓               ↓
            SUSTENTAÇÃO     ENGENHARIA       PRODUTO
                 ↓              ↓               ↓
                 └──────────────┼───────────────┘
                                ↓
                         BACKLOG GOALFY
                                ↓
                          PRIORIZAÇÃO
                                ↓
                            EXECUÇÃO
```

---

# 5. Processo de Triagem N2/N3

## 1. Reporte

Quem identifica o problema abre o tópico no Discord com contexto suficiente para investigação.

---

## 2. Triagem

O responsável pelo N2/N3:

- Analisa o tópico;
- Valida as informações;
- Tenta reproduzir o problema;
- Solicita informações adicionais quando necessário;
- Verifica se já existe uma ocorrência/card relacionado;
- Realiza o diagnóstico inicial.

---

## 3. Classificação

Após entender a ocorrência, determina seu destino.

| Diagnóstico | Destino |
| --- | --- |
| Dúvida, configuração ou uso incorreto | Resolver pelo próprio atendimento |
| Comportamento existente incorreto | 🛠️ Sustentação |
| Regressão | 🛠️ Sustentação |
| Necessidade de novo comportamento | 🚀 Produto |
| Evolução funcional | 🚀 Produto |
| Problema estrutural de performance | 🏗️ Engenharia |
| Arquitetura / escalabilidade | 🏗️ Engenharia |
| Segurança / infraestrutura | 🏗️ Engenharia |
| Diagnóstico ainda inconclusivo | Triagem técnica / escalonamento |

---

# 6. Quando Criar um Card

### Não precisa criar card

Quando o problema for resolvido durante a própria triagem:

- Dúvida;
- Configuração;
- Uso incorreto;
- Problema não reproduzido;
- Ocorrência já existente;
- Orientação ao usuário.

O tópico pode ser encerrado no Discord.

### Precisa criar card

Quando for necessário trabalho da equipe para:

- Corrigir código;
- Alterar comportamento;
- Desenvolver funcionalidade;
- Fazer melhoria;
- Alterar arquitetura;
- Trabalhar performance;
- Corrigir segurança;
- Trabalhar infraestrutura;
- Resolver dívida técnica.

> **Se existe trabalho a ser executado, precisa existir um card.**
> 

---

# 7. Papéis e Responsabilidades

## 👤 Quem identificou a ocorrência

Responsável por:

- Abrir o tópico no Discord;
- Explicar o problema;
- Informar cliente/organização quando aplicável;
- Fornecer prints, vídeos ou evidências;
- Informar como reproduzir quando souber;
- Responder dúvidas da triagem.

Não precisa decidir:

- Frente;
- Prioridade;
- DEV responsável;
- Prazo.

---

# 🧑‍💻 Responsável pela Triagem N2/N3

### Missão

> Garantir que toda ocorrência técnica tenha diagnóstico inicial, classificação e destino correto, resolvendo diretamente os casos compatíveis com seu nível técnico.
> 

Responsabilidades:

- Acompanhar novos tópicos;
- Validar contexto;
- Reproduzir problemas;
- Buscar informações faltantes;
- Identificar duplicidades;
- Realizar diagnóstico inicial;
- Classificar a ocorrência;
- Criar o card quando necessário;
- Vincular Discord ↔ Goalfy;
- Resolver diretamente problemas simples;
- Escalar problemas de maior complexidade.

### Regra principal

> **Nenhum N2/N3 termina sem um destino.**
> 

---

# 8. Evolução do Papel para DEV N2

O responsável atual pela triagem está em processo de evolução técnica. A responsabilidade pode crescer progressivamente.

## Fase 1 — Triagem Técnica

Foco em:

- Entender;
- Reproduzir;
- Diagnosticar;
- Classificar;
- Documentar;
- Encaminhar.

O objetivo é aumentar progressivamente o conhecimento técnico da plataforma.

---

## Fase 2 — Triagem + Resolução

Além da triagem, começa a assumir:

- Bugs simples;
- Pequenos ajustes;
- Quick Wins técnicos;
- Correções de baixo risco;
- Problemas conhecidos;
- Alterações de menor complexidade.

---

## Fase 3 — DEV N2

Passa a absorver uma parcela relevante da fila de Sustentação.

Resolve diretamente o que estiver dentro de sua capacidade e escala somente problemas de maior complexidade.

```
Triagem Técnica
      ↓
Triagem + Resolução
      ↓
    DEV N2
```

---

# 9. Quando o DEV N2 Deve Escalar

### Pode resolver diretamente

- Bugs simples;
- Pequenas correções;
- Investigação;
- Reprodução;
- Quick Wins técnicos;
- Alterações de baixo risco;
- Problemas já conhecidos.

### Deve escalar

Quando envolver:

- Mudança arquitetural;
- Segurança;
- Performance estrutural;
- Infraestrutura;
- Alteração complexa de regra de negócio;
- Alto risco de regressão;
- Conhecimento profundo de determinado módulo;
- Problemas cuja solução técnica não esteja clara.

> O objetivo não é fazer do DEV N2 **“a pessoa que resolve qualquer problema”**, mas aumentar a quantidade de ocorrências que podem ser resolvidas antes de consumir capacidade dos demais desenvolvedores.
> 

---

# 10. Responsabilidade de Produto / Tecnologia

Produto/Tecnologia é responsável por:

- Priorizar demandas;
- Definir capacidade entre as três frentes;
- Decidir o que entra em execução;
- Avaliar demandas estratégicas;
- Apoiar problemas técnicos complexos;
- Definir prioridades de Engenharia;
- Resolver conflitos de prioridade.

A triagem **não assume compromisso de prazo**.

O fato de um card ter sido criado significa:

> **“Identificamos uma demanda que precisa ser tratada.”**
> 

Não significa:

> **“Assumimos que será entregue imediatamente.”**
> 

---

# 11. Informações Mínimas do Tópico no Discord

Ao abrir um N2/N3, incluir sempre que possível:

**Título**

Descrição objetiva do problema.

**Origem**

`Suporte | Consultoria | Produto | Interno | Outra`

**Cliente / Organização**

Quando aplicável.

**Ambiente**

`Produção | Homologação | Desenvolvimento`

**Comportamento atual**

O que está acontecendo.

**Comportamento esperado**

O que deveria acontecer.

**Como reproduzir**

Passos necessários para chegar ao problema.

**Evidências**

Print, vídeo, log, mensagem de erro etc.

**Impacto**

Como isso está afetando o usuário/cliente.

---

# 12. Informações do Card na Goalfy

Quando a triagem gerar trabalho, criar o card contendo:

### Frente

`Sustentação | Engenharia | Produto`

### Tipo

Exemplos:

`Bug | Regressão | Melhoria | Feature | Performance | Segurança | Tech Debt | DevOps`

### Origem

`Suporte | Consultoria | Produto | Interno | Outra`

### Cliente

Quando aplicável.

### Severidade

Quando for problema/bug.

### Referências

- Link do tópico do Discord;
- Link do ticket N1, quando houver.

### Descrição

Resumo suficiente para entender a necessidade.

### Resultado esperado

O que caracteriza o problema como resolvido.

---

# 13. Severidade ≠ Prioridade

São conceitos diferentes.

### Severidade

Responde:

> **Qual o impacto desse problema?**
> 

| Severidade | Referência |
| --- | --- |
| 🔴 **S1 — Crítico** | Operação indisponível, perda/corrupção de dados, segurança crítica ou impacto generalizado |
| 🟠 **S2 — Alto** | Função importante bloqueada ou impacto relevante sem alternativa adequada |
| 🟡 **S3 — Médio** | Impacto limitado ou existe workaround |
| ⚪ **S4 — Baixo** | Impacto pequeno, visual ou situação pouco frequente |

### Prioridade

Responde:

> **Quando decidimos trabalhar nisso?**
> 

Um problema pode ter severidade relevante e ainda precisar competir com outras demandas.

Incidentes críticos podem interromper a fila normal.

---

# 14. Status dos Tópicos no Discord

Todo tópico deve chegar a um estado claro.

Sugestão:

`🔎 Em Triagem`

Diagnóstico sendo realizado.

`⏳ Aguardando Informação`

Faltam informações do solicitante ou cliente.

`📋 Card Criado`

Existe trabalho e a demanda foi registrada na Goalfy.

`✅ Resolvido`

Problema solucionado.

`❌ Não Procede`

Comportamento esperado, duplicidade ou problema não confirmado.

---

# 15. Relação Discord ↔ Goalfy

Não precisamos duplicar toda a conversa.

### Discord

Mantém:

- Conversas;
- Prints;
- Vídeos;
- Evidências;
- Discussão;
- Investigação.

### Goalfy

Mantém:

- Demanda;
- Classificação;
- Prioridade;
- Responsável;
- Status;
- Planejamento;
- Execução;
- Histórico da entrega.

O card deve possuir o **link do tópico do Discord**.

O tópico do Discord deve possuir o **link do card da Goalfy**.

---

# 16. Gestão do Backlog

O backlog é único, mas cada item pertence a uma das três frentes:

```
                    EQUIPE DE PRODUTO
                           │
           ┌───────────────┼───────────────┐
           ↓               ↓               ↓
     SUSTENTAÇÃO       ENGENHARIA        PRODUTO
           │               │               │
           └───────────────┼───────────────┘
                           ↓
                     BACKLOG ÚNICO
```

Podemos criar views específicas:

### 🛠️ Sustentação

Somente demandas relacionadas à manutenção da operação.

### 🏗️ Engenharia

Arquitetura, performance, escala, segurança e infraestrutura.

### 🚀 Produto

Features e evoluções funcionais.

### 🎯 Foco Atual

Somente aquilo que realmente está priorizado e em execução.

---

# 17. Regras Gerais

> **Regra 1:** Nenhum trabalho relevante deve existir somente no Discord.
> 

> **Regra 2:** Nem todo tópico do Discord precisa virar trabalho.
> 

> **Regra 3:** Criar card não significa assumir prazo.
> 

> **Regra 4:** Urgência do solicitante não significa automaticamente prioridade.
> 

> **Regra 5:** A triagem classifica; Produto/Tecnologia prioriza.
> 

> **Regra 6:** O DEV N2 resolve aquilo que estiver dentro de sua capacidade e escala o restante.
> 

> **Regra 7:** Problemas recorrentes devem gerar análise de causa raiz e podem se transformar em demandas de Engenharia.
> 

> **Regra 8:** Nenhum tópico N2/N3 fica sem destino.
> 

---

# 18. Indicadores para Acompanhar

Com o processo funcionando, podemos começar a acompanhar:

- N2/N3 abertos por semana;
- N2/N3 resolvidos na própria triagem;
- Cards gerados por N2/N3;
- Bugs por módulo;
- Regressões;
- Distribuição por severidade;
- Tempo médio até triagem;
- Tempo médio até resolução;
- Itens resolvidos diretamente pelo DEV N2;
- Itens escalados para outros DEVs;
- Problemas recorrentes;
- Origem das demandas;
- Volume de Sustentação × Engenharia × Produto.

Esses indicadores ajudarão a decidir posteriormente se a capacidade atual é suficiente ou se é necessário ampliar a equipe.

---

# 19. Fluxo Resumido

```
Ocorrência identificada
        ↓
Discord N2/N3
        ↓
Triagem Técnica
        ↓
Reproduzir + Diagnosticar
        ↓
        ├── Dúvida/configuração
        │       ↓
        │    Resolver
        │
        └── Existe trabalho
                ↓
             Classificar
                ↓
       ┌────────┼────────┐
       ↓        ↓        ↓
 Sustentação Engenharia Produto
       └────────┼────────┘
                ↓
           Card Goalfy
                ↓
           Priorização
                ↓
             Execução
                ↓
            QA / Deploy
                ↓
             Resolvido
```

---

# Resultado Esperado

O processo estará funcionando quando conseguirmos:

**1.** Manter a agilidade do Discord sem perder demandas.

**2.** Olhar para a Goalfy e enxergar a **carga real de trabalho** da equipe.

**3.** Saber quanto da capacidade está sendo consumida por **Sustentação, Engenharia e Produto**.

**4.** Evitar que bugs e problemas técnicos fiquem esquecidos em conversas.

**5.** Evitar que todo problema técnico chegue diretamente aos desenvolvedores.

**6.** Desenvolver progressivamente o responsável pela triagem até assumir o papel de **DEV N2**.

**7.** Dar clareza para toda a empresa sobre a diferença entre **registrar uma demanda, priorizar uma demanda e assumir um compromisso de entrega**.

**Diagramas**