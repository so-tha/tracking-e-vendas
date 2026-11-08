# 03 — Fluxo do Sistema

## Arquitetura geral

```mermaid
flowchart LR
    CK[Checkout / Navegador] -->|POST /tracking/sessions| API
    PL[Plataforma de pedidos] -->|POST /webhooks/orders| API
    SUP[Suporte] -->|GET e POST /support/*| API
    API --> DB[(PostgreSQL)]
    W[Worker] -->|consome jobs| DB
    W --> ATT[Atribuição]
    W --> CNV[Conversões]
    CNV --> PROV[Meta / Google / TikTok / UTMify / RedTrack]
```

## Responsabilidade de cada parte

| Parte | Responsabilidade | Estado |
|---|---|---|
| API (`server.ts`, `app.ts`) | Recebe requisições, valida, grava e enfileira | Todas as rotas implementadas (Etapas 1 a 6) |
| Worker (`worker.ts`) | Consome a fila e executa atribuição e conversões | Implementado (Etapas 3 a 5) |
| `attribution` | Descobre sessão, campanha e origem. Não conhece provedores | Implementado (Etapa 4) |
| `conversions` | Entrega ao provedor com retry. Não conhece regras de atribuição | Implementado (Etapa 5) |
| `support` | Diagnóstico e reprocessamento | Implementado (Etapa 6) |

## Infraestrutura local (implementada)

- PostgreSQL 17 via Docker Compose, com dois bancos: `tracking_hub` (aplicação) e `tracking_hub_test` (testes de integração, criado por `docker/init-test-db.sql`).
- A execução completa (banco, migrations, API e worker) está descrita na seção "Execução com Docker Compose", no fim deste documento.

## Etapa 1 (implementada)

**Inicialização da API:** `server.ts` carrega a configuração (`loadConfig`). Se algo estiver inválido, registra o motivo (sem valores) e encerra com erro. Em seguida cria o cliente do banco, monta o app e começa a ouvir.

```mermaid
flowchart TD
    A[node dist/server.js] --> B{loadConfig valida o ambiente}
    B -- inválido --> X[log fatal + exit 1]
    B -- ok --> C[createPrismaClient com adapter pg]
    C --> D[createApp]
    D --> E[Express ouve em PORT]
    E --> F[GET /health executa SELECT 1 com timeout de 2s]
    F -- ok --> G[200 ok]
    F -- falha --> H[503 degraded, erro só no log]
```

**Tratamento de erros:** rota inexistente responde `404 {"error":"not_found"}`. JSON malformado responde `400 {"error":"invalid_json"}`. Erro inesperado responde `500 {"error":"internal_error"}` e o detalhe só vai para o log.

**Persistência:** 9 tabelas conforme o ADR-027. A idempotência é garantida por constraints únicas do PostgreSQL: `sessionId`, `eventId`, `orderId`, `(orderId, provider)`, `dedupKey` de conversão e de job, um snapshot por pedido e `(conversionId, attemptNumber)`.

**Logs:** o Pino oculta e-mail, telefone, chaves de API e cabeçalhos de autenticação (ADR-019).

## Etapa 2 (implementada): `POST /tracking/sessions`

```mermaid
sequenceDiagram
    participant C as Checkout
    participant R as routes.ts
    participant Z as schemas.ts (Zod)
    participant S as service.ts
    participant D as PostgreSQL
    C->>R: POST /tracking/sessions
    R->>Z: validar
    alt inválido
        Z-->>C: 400 (caminho e motivo, sem valores)
    else válido
        R->>S: normalizar + upsertSession
        S->>D: BEGIN
        S->>D: pg_advisory_xact_lock(sessionId)
        S->>D: SELECT sessão
        alt não existe
            S->>D: INSERT sessão
        else existe
            S->>S: mergeSession (função pura)
            S->>D: UPDATE só campos complementados
        end
        S->>D: INSERT revisão (payload, mudanças, conflitos)
        S->>D: COMMIT
        S-->>C: 201 criou / 200 atualizou
    end
```

**Regras do merge (`merge.ts`):**

| Campo | Regra |
|---|---|
| Identificadores, e-mail, telefone | Vazio e recebido: complementa. Preenchido e diferente: mantém o original e registra conflito. Nulo recebido nunca apaga. |
| `customFields` | Objeto atômico. Preenchido uma vez. Outro objeto diferente vira conflito, sem merge por chave. `{}` conta como ausente. |
| `pageUrl` | A primeira é preservada. As demais ficam só no histórico. |

**Tratamento de erros:** `400 validation_error` (detalhes com caminho e motivo, sem valores), e-mail ou telefone inválidos viram `warnings` sem perder a sessão.

**Segurança:** a resposta só informa os nomes dos campos em conflito, nunca os valores, porque o endpoint é público. O lock consultivo por `sessionId` evita atualizações perdidas em requisições simultâneas.

## Etapa 3 (implementada): webhook, fila e pedido

```mermaid
sequenceDiagram
    participant P as Plataforma
    participant A as API (ingest.ts)
    participant D as PostgreSQL
    participant W as Worker (JobRunner)
    P->>A: POST /webhooks/orders
    alt faltam eventId, event, orderId ou, em ORDER_PAID, amount e currency válidos
        A-->>P: 400 (caminho e motivo)
    else válido
        A->>D: BEGIN
        A->>D: INSERT WebhookEvent ON CONFLICT (eventId) DO NOTHING
        alt eventId já existia
            A-->>P: 202 duplicate
        else novo ORDER_PAID
            A->>D: INSERT Job (mesma transação)
            A->>D: COMMIT
            A-->>P: 202 accepted
        else novo evento de outro tipo
            A->>D: status IGNORED_UNSUPPORTED, sem job
            A-->>P: 202 accepted (ignored)
        end
    end
    loop a cada poll
        W->>D: claim: UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
        W->>D: BEGIN + lock consultivo por orderId
        alt pedido já existe
            W->>D: evento = DUPLICATE_ORDER
        else
            W->>D: INSERT Order + evento = PROCESSED
        end
        W->>D: job = DONE
    end
```

**Ciclo de vida do job:** `PENDING` -> (claim) `RUNNING` -> `DONE`. Se o handler falha: volta a `PENDING` com `runAt` no futuro (backoff exponencial com jitter) até `JOB_MAX_ATTEMPTS`, e depois `FAILED`. Erro permanente ou tipo sem handler vai direto a `FAILED`. `RUNNING` há mais de `JOB_LOCK_TIMEOUT_MS` é considerado abandonado e é retomado.

**Status do evento:** `RECEIVED` (aguardando), `PROCESSED`, `IGNORED_UNSUPPORTED`, `DUPLICATE_ORDER`, `FAILED` (reservado).

**Tratamento de erros:** `400 validation_error` sem valores. Campos opcionais malformados viram `warnings` e a venda é aceita. Falha no worker nunca perde o evento: ele já está gravado com o payload original.

**Garantias de idempotência (de fora para dentro):** `eventId` único no banco, `dedupKey` única do job, lock consultivo por `orderId` no worker e `orderId` único no banco.

## Etapa 4 (implementada): atribuição

O handler do worker agora cria o pedido **e** o snapshot de atribuição na mesma transação.

```mermaid
flowchart TD
    A[Job PROCESS_ORDER_EVENT] --> B[Lock por orderId + relê o evento]
    B --> C{Pedido já existe?}
    C -- sim --> D[Evento = DUPLICATE_ORDER, sem snapshot]
    C -- não --> E[Cria Order]
    E --> F[Fase 1: reúne evidências de todos os níveis]
    F --> G[Fase 2: decide]
    G --> H[Cria AttributionSnapshot]
    H --> I[Evento = PROCESSED]
```

**Níveis (fase 2, em ordem):**

| Nível | Evidência | Regra |
|---|---|---|
| 1 | `sessionId` do webhook existe | Vence sempre que existir |
| 2 | `utmifyId`, `redtrackClickId` | Exatamente 1 sessão distinta |
| 3 | `fbclid`, `fbc`, `gclid`, `gbraid`, `wbraid`, `ttclid` (nunca `fbp`/`ttp`) | Exatamente 1 sessão distinta |
| 4 | E-mail do cliente, `firstSeenAt` em `[receivedAt − 24h, receivedAt]` | Exatamente 1 sessão |
| 5 | Nenhuma evidência utilizável | Não atribuída |

Em cada nível: nenhuma sessão, passa para o seguinte. Uma sessão, atribui. **Mais de uma, não atribui e para** (sem tentar o nível seguinte).

**O que o snapshot guarda:** resultado, nível e método, sessão, `customFields` com origem (`WEBHOOK`, `SESSION` ou `NONE`), identificadores efetivos com origem por campo, `affiliateCode` com origem e nível de evidência, alertas e o rastro da decisão.

**Origem de cada dado:**

| Dado | Quando o valor vem do webhook | Quando vem da sessão |
|---|---|---|
| `customFields` | Webhook tem objeto não vazio (inteiro, sem mesclar) | Webhook sem objeto e há sessão atribuída |
| Identificadores | Não há sessão atribuída | Há sessão atribuída (os do webhook só servem para casar e detectar conflito) |
| `affiliateCode` | Vem de dentro do `customFields` usado, e herda a origem dele | idem |

**Alertas:** `ATTRIBUTION_CONFLICT` (outra sessão em outro nível, identificador ou e-mail divergente do da sessão vencedora, sempre mantendo a vencedora) e `CUSTOM_FIELDS_DIVERGENCE`.

**Motivos de não atribuição:** `NO_EVIDENCE`, `NO_MATCHING_SESSION`, `AMBIGUOUS_PLATFORM_IDENTIFIER`, `AMBIGUOUS_CLICK_ID`, `AMBIGUOUS_CUSTOMER_WINDOW`.

**Imutabilidade:** o snapshot é único por pedido (constraint) e nunca é recalculado. Reprocessar o job não o altera, e uma sessão que chega depois do pedido não o muda (limitação conhecida, ADR-023).

**Tempo:** a janela usa o `receivedAt` do evento, e não o horário em que o worker processa. Processar dias depois dá o mesmo resultado.

## Etapa 5 (implementada): conversões

**Criação (no handler do pedido, na mesma transação):** depois do snapshot, monta-se **um** `ConversionEvent` congelado e cria-se **uma** `Conversion` por provedor.

```mermaid
flowchart TD
    A[Snapshot de atribuição] --> B[buildConversionEvent: evento congelado]
    B --> C{Para cada provedor: eligibility}
    C -- atende os requisitos --> D[Conversion PENDING + job DELIVER_CONVERSION]
    C -- não atende --> E[Conversion SKIPPED com skipReason, sem job, sem tentativa]
```

**Entrega (job `DELIVER_CONVERSION`, um por conversão):**

```mermaid
flowchart TD
    A[Job] --> B{Conversion está PENDING?}
    B -- não --> Z[Nada a fazer: nunca reenvia]
    B -- sim --> C{Evento com mais de 7 dias? Meta e UTMify}
    C -- sim, sem tentativas --> S[SKIPPED: EVENT_TOO_OLD]
    C -- sim, com tentativas --> F1[FAILED_PERMANENT: EVENT_TOO_OLD]
    C -- não --> D[provider.send do evento congelado, FORA da transação]
    D --> E{Resultado}
    E -- SUCCESS --> OK[DELIVERED + DeliveryAttempt SUCCESS]
    E -- PERMANENT --> F2[FAILED_PERMANENT PROVIDER_REJECTED + DeliveryAttempt]
    E -- TRANSIENT --> G{Tentativas esgotadas?}
    G -- sim --> F3[FAILED_PERMANENT RETRIES_EXHAUSTED]
    G -- não --> R[Continua PENDING + job reagendado: maior entre backoff e Retry-After]
```

**Estados da conversão:** `PENDING` -> `DELIVERED`, `FAILED_PERMANENT` ou `SKIPPED`. Só `PENDING` é enviável. Os outros são finais (o reprocessamento de falhas permanentes é um pedido explícito da Etapa 6).

**Classificação do resultado:**

| Resultado | Tratamento |
|---|---|
| 2xx | Sucesso |
| Rede, timeout, 408, 425, 429, 5xx | Transitório: retry com backoff exponencial e jitter, respeitando `Retry-After` |
| Demais 4xx, inclusive 401 e 403 | Permanente |
| TikTok: HTTP 200 com `code` diferente de 0 | Permanente (suposição) |
| Bug inesperado no adaptador | Transitório (`UNEXPECTED_ADAPTER_ERROR`), limitado por `CONVERSION_MAX_ATTEMPTS` |
| `ContractError` | `FAILED_PERMANENT` sem tentativa |

**Por que o payload não muda entre tentativas:** o evento é congelado em `Conversion.eventSnapshot`. Cada tentativa reconstrói o request a partir dele, então novos dados da sessão não alteram o que é reenviado.

**Auditoria por tentativa (`DeliveryAttempt`):** número, status, HTTP, resposta, erro, início e fim, e o request efetivamente enviado (método, URL e corpo, **sem cabeçalhos nem credenciais**).

**Isolamento:** um job por conversão, e cada adaptador com seu transporte. Falha, lentidão ou bug em um provedor não afeta os outros.

**Eligibilidade por provedor (identificadores obrigatórios):**

| Provedor | Obrigatório | Outras regras |
|---|---|---|
| Meta | `fbc` ou `fbp` | `pageUrl`, evento com no máximo 7 dias |
| Google | `gclid`, `gbraid` ou `wbraid` | Sem limite de idade |
| TikTok | `ttclid` ou `ttp` | Sem limite de idade |
| UTMify | E-mail do cliente, e `utmifyId` ou `customFields` de campanha | Evento com no máximo 7 dias |
| RedTrack | `redtrackClickId` | Sem limite de idade |

**Origem dos dados pessoais do cliente:** o e-mail vem do webhook (ou da sessão atribuída, sem conflito). O telefone só vem da sessão atribuída, sem conflito. Havendo `ATTRIBUTION_CONFLICT`, nenhum dado pessoal da sessão é usado.

## Etapa 6 (implementada): suporte

**Autenticação (`/support/*`):**

```mermaid
flowchart TD
    A[Requisição a /support] --> B{X-API-Key presente e com até 256 caracteres?}
    B -- não --> X[401 unauthorized]
    B -- sim --> C[SHA-256 da chave comparado com TODOS os operadores via timingSafeEqual]
    C --> D{Algum operador casa?}
    D -- não --> X
    D -- sim --> E[Operador = nome da CONFIGURAÇÃO da chave]
    E --> F[Handler. Cabeçalhos ou corpo com outro nome de operador são ignorados]
```

**`GET /support/orders/:orderId/tracking`:** reúne em uma resposta o que o suporte precisa para responder "qual valor foi associado à venda, de onde ele veio e exatamente o que foi enviado".

| Bloco | Conteúdo |
|---|---|
| `order` | Valor (centavos e decimal), moeda, instante da recepção, e-mail **mascarado** |
| `events` | Eventos do pedido e o estado de cada um, com explicação |
| `attribution` | Resultado, nível, explicação, alertas explicados, rastro por nível, sessão e conflitos da sessão |
| `trackingData` | `customFields` e identificadores **com a origem** (`WEBHOOK` ou `SESSION`), afiliado com nível de evidência e se vai aos provedores |
| `conversions` | Por provedor: status, explicação, próxima tentativa, identificadores usados (valor e origem), request enviado e tentativas (HTTP, erro, resposta) |
| `reprocessRequests` | Quem pediu, quando, com qual opção e o que foi feito |

Todo o JSON passa pela máscara de dados pessoais. Hashes SHA-256 são preservados (são a prova do que foi enviado). O payload bruto do webhook e o evento congelado nunca saem.

**`POST /support/orders/:orderId/reprocess`:**

```mermaid
flowchart TD
    A[Pedido de reprocessamento] --> L[Lock por pedido + registra ReprocessRequest: data e operador]
    L --> E{Eventos RECEIVED?}
    E -- job ativo --> E1[ALREADY_SCHEDULED]
    E -- job perdido --> E2[Reenfileira o processamento do evento]
    L --> C{Cada conversão}
    C -- DELIVERED ou SKIPPED --> N[NOTHING_TO_DO]
    C -- PENDING com job ativo --> P1[ALREADY_SCHEDULED: respeita o backoff]
    C -- PENDING sem job --> P2[ENQUEUED]
    C -- FAILED_PERMANENT, sem o pedido explícito --> F1[NOT_RETRIED_PERMANENT_FAILURE]
    C -- FAILED_PERMANENT, com o pedido, EVENT_TOO_OLD ou CONTRACT_ERROR --> F2[NOT_RETRYABLE]
    C -- FAILED_PERMANENT, com o pedido, repetir pode resolver --> F3[Reinicia: status PENDING, orçamento novo de tentativas, novo job]
```

**Orçamento de tentativas:** `attemptNumber` só cresce (é único por conversão e preserva o histórico). O limite conta `attemptCount − attemptBudgetBase`, e o reinício define a base como o `attemptCount` atual.

**Por que o reprocessamento não muda nada do que já foi decidido:** o snapshot de atribuição e o `ConversionEvent` são imutáveis. Só o status das conversões e os jobs de entrega mudam.

## Execução com Docker Compose (Etapa 7)

```mermaid
flowchart LR
    DB[(db: PostgreSQL 17)] -- healthy --> M[migrate: prisma migrate deploy]
    M -- concluído com sucesso --> API[api: node dist/server.js, porta 3333]
    M -- concluído com sucesso --> W[worker: node dist/worker.js]
    API --> DB
    W --> DB
```

- **Uma imagem** (`tracking-hub:local`) para API e worker, construída em estágios: as dependências de desenvolvimento ficam fora do runtime, que roda como o usuário `node`.
- **`migrate`** usa o estágio de build (que tem a CLI do Prisma), aplica as migrations e termina. API e worker só sobem depois que ele conclui com sucesso.
- A **API** tem healthcheck em `/health`. O **worker** não expõe porta.
- A configuração vem do `.env`. A URL do banco é sobrescrita no Compose para apontar ao serviço `db`.

## Contrato (Etapa 7)

A coleção do Postman (`postman/`) é o contrato entregue. Um teste automatizado confere que ela cobre todas as rotas do código e executa cada requisição dela contra a API real, verificando o status esperado. Se o código ganhar uma rota nova ou a coleção divergir, o teste falha.
