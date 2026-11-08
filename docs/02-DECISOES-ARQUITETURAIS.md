# 02 — Decisões Técnicas

Decisões que definem o comportamento do sistema, agrupadas por tema. O número (ADR) é o que o código cita nos comentários.
**Quem decidiu:** **U** = usuário, **A** = decisão técnica do desenvolvimento, registrada para ciência.
A versão completa (com alternativas e consequências de cada decisão) fica guardada localmente em `docs/historico/`.

## Arquitetura e infraestrutura

| ADR | Decisão | Por quê | Quem |
|---|---|---|---|
| 025 | Monólito modular com dois processos do mesmo código: API e worker. | Separa receber de processar, sem a complexidade de vários serviços. | U |
| 009 | Atribuição e conversão são módulos separados, ligados por um snapshot gravado. | Responsabilidades diferentes. Permite reenviar conversões sem refazer a atribuição. | U |
| 026 | Fila em tabela do PostgreSQL (`FOR UPDATE SKIP LOCKED`), atrás da interface `JobQueue`. O evento e o job são gravados na mesma transação. | Nenhuma venda se perde entre gravar e enfileirar, e não há infraestrutura extra. Trocável por Redis/BullMQ. | U |
| 030 | Prisma 7 estável (não o 8, que é release candidate). | O documento pede Prisma com migrations, e uma versão estável. | A |
| 041 | Docker: uma imagem multi-stage para API e worker, sem dependências de desenvolvimento, rodando sem root. As migrations rodam num serviço que termina antes de a API subir. | Sobe do zero com `docker compose up --build`. | A |

## Dados e idempotência

| ADR | Decisão | Por quê | Quem |
|---|---|---|---|
| 027 | Identificadores em colunas indexadas, e `customFields` como JSON. | Busca rápida por identificador. | U |
| 003, 015 | Unicidade garantida pelo banco: `eventId`, `orderId` (global), uma conversão por (pedido, provedor), um snapshot por pedido. Um segundo evento com o mesmo `orderId` é registrado como `DUPLICATE_ORDER`. | "Verificar antes de inserir" falha com requisições simultâneas. Constraint não. | U |
| 007, 017 | Valor como inteiro na menor unidade da moeda (`BigInt`), moeda ISO 4217, sem conversão cambial. A conversão para decimal não usa ponto flutuante. | Sem erro de arredondamento e correto para moedas com 0 ou 3 casas. | U |
| 005 | Só `ORDER_PAID` é processado. Outros eventos são registrados com o payload e ignorados. | Auditoria completa, sem efeitos colaterais. | U |
| 033 | No webhook, só `eventId`, `event`, `orderId`, `amount` e `currency` são obrigatórios. Campos opcionais malformados são ignorados com aviso. | Perder uma venda paga por causa de um campo opcional seria pior. | A |

## Sessões de tracking

| ADR | Decisão | Por quê | Quem |
|---|---|---|---|
| 004, 014, 022 | Upsert controlado: campos vazios são completados, e um valor já preenchido **nunca** é sobrescrito (first-write-wins). Divergências vão para o histórico de conflitos. `customFields` é um objeto único, nunca mesclado por chave. A primeira `pageUrl` é mantida. | O endpoint é público: sem isso, qualquer um trocaria o afiliado de uma sessão. | U |
| 032, 034 | E-mail ou telefone inválidos são ignorados com aviso, e não gravados em lugar nenhum. A resposta traz só os **nomes** dos campos em conflito. | Não perder a sessão por formato. Não expor dados de outra sessão. | A, U |

## Atribuição

| ADR | Decisão | Por quê | Quem |
|---|---|---|---|
| 001, 013, 020 | Ordem: (1) `sessionId`; (2) `utmifyId` ou `redtrackClickId`; (3) click IDs (`fbclid`, `fbc`, `gclid`, `gbraid`, `wbraid`, `ttclid`); (4) e-mail do cliente com sessão iniciada até 24h antes do recebimento do pedido; (5) não atribuída. `fbp` e `ttp` nunca atribuem sozinhos. | Do mais forte ao mais fraco. Cookies de navegador são compartilhados entre sessões. | U |
| 003, 020, 035 | Mais de uma sessão possível no mesmo nível: a venda fica **não atribuída** e a busca para. | Nunca escolher no palpite (evita afiliado errado). | U |
| 012 | Evidências de níveis diferentes apontando para sessões diferentes: vence o nível mais alto, com o alerta `ATTRIBUTION_CONFLICT`. | Mantém a venda e deixa a divergência visível. | U |
| 011 | `customFields`: o objeto inteiro do webhook se vier, senão o da sessão. | Campanha e afiliado vêm sempre da mesma fonte. | U |
| 021 | Identificadores enviados aos provedores: os da sessão atribuída. Sem sessão, os do próprio webhook. | Cada dado tem uma origem única e auditável. | U |
| 010 | A atribuição é gravada uma vez (snapshot) e nunca recalculada. | O que foi enviado continua explicável, e reprocessar é seguro. | U |
| 023 | Uma sessão que chega depois do pedido não corrige a atribuição. | Limitação aceita (determinismo). | U |
| 006, 018 | Sem cálculo de comissão. O `affiliateCode` é guardado com origem e nível de evidência, e só é enviado quando a atribuição foi pelos níveis 1 a 3. | O documento não define a comissão. Evidência fraca não decide afiliado. | U |

## Conversões

| ADR | Decisão | Por quê | Quem |
|---|---|---|---|
| 036 | Um evento de conversão é montado e **congelado** na criação, e todas as tentativas o reutilizam. Uma conversão por provedor, cada uma com seu job. | Reprocessar envia exatamente o mesmo payload. Falha de um provedor não afeta os outros. | U |
| 016 | Cada adaptador declara os identificadores obrigatórios. Sem eles, a conversão fica `SKIPPED` com o motivo, sem tentativa. Envio só com e-mail com hash está fora do escopo. | Explica ao suporte por que não foi enviada. | U |
| 036 | Retry só para erro transitório (rede, timeout, 408, 425, 429, 5xx), com backoff exponencial até `CONVERSION_MAX_ATTEMPTS`. Os demais 4xx são permanentes. Tentativas esgotadas viram `FAILED_PERMANENT`. | Retry controlado e sem loop infinito. | U |
| 043 | TikTok: `code` 40100 no corpo (limite de requisições, confirmado na documentação oficial) é transitório, com espera de 5 minutos. Os demais códigos diferentes de 0 são permanentes (suposição). | Um limite de requisições não pode perder a conversão. | U |
| 036, 039 | Cada tentativa grava número, status, HTTP, resposta, erro, datas e o request enviado, **sem cabeçalhos nem credenciais**. | Auditoria do que foi enviado, sem vazar segredos. | U, A |
| 038 | E-mail e telefone são normalizados conforme cada provedor e enviados com SHA-256 (Meta, Google, TikTok). Identificadores de clique nunca levam hash. O RedTrack não recebe dados pessoais. | Hash de texto mal normalizado não casa, e falha em silêncio. | U |
| 037 | Contratos seguem a documentação oficial quando acessível. O resto é suposição declarada (tabela abaixo). | Os provedores são simulados, mas os payloads precisam ser coerentes. | A |

### Contratos dos provedores: confirmado x suposição

| Provedor | Confirmado em fonte oficial | Suposição |
|---|---|---|
| Meta | Endpoint `/{pixel}/events`, campos obrigatórios, janela de 7 dias, hash de `em`/`ph`, `fbc`/`fbp` sem hash, deduplicação por `event_name` + `event_id` | Versão `v27.0`, `custom_data`. **Desvio:** IP e user agent não capturados |
| Google | Data Manager API `events:ingest` (a API antiga está restrita desde 15/06/2026), `transactionId`, identificadores de clique, regra de e-mail do Gmail, E.164 | Nomes dos campos dentro de `userData`. `consent` omitido |
| TikTok | Deduplicação (`event` + `event_id`, 48h), código 40100 de limite | Endpoint e campos (fontes secundárias) |
| UTMify | Contrato de envio de vendas completo | Valores padrão para o que o webhook não traz: nome, método de pagamento, produtos, taxas |
| RedTrack | `clickid` e valor obrigatórios, tipos que diferenciam maiúsculas, deduplicação por `rdtk_event_id` | Formato da URL do postback (guias de parceiros) |

O afiliado só vai para a Meta (`custom_data`): UTMify e RedTrack não têm campo documentado para ele.

## Suporte e segurança

| ADR | Decisão | Por quê | Quem |
|---|---|---|---|
| 008 | Webhook e sessões sem autenticação (HMAC fica para produção). | Fora do escopo do documento. | U |
| 024 | `/support/*` exige `X-API-Key` por operador, comparada com segurança contra ataques de tempo. O operador registrado vem só da configuração da chave, nunca do cliente. | Acesso a dados de clientes e trilha de auditoria confiável. | U |
| 019 | E-mail, telefone, documento e nome saem mascarados no suporte. O payload bruto do webhook não é devolvido. Logs não registram dados pessoais nem chaves. | Proteção de dados pessoais. | U |
| 040 | Reprocessar: não reenvia o que foi entregue nem acelera retries agendados. Falha permanente só volta com `includePermanentFailures`, e ganha um orçamento novo de tentativas, preservando o histórico. | Caso de teste 6, sem perder auditoria. | U |

## Testes e entrega

| ADR | Decisão | Por quê | Quem |
|---|---|---|---|
| 029 | Vitest com PostgreSQL real, relógio injetável e provedores simulados. | Constraints e concorrência só se provam com banco de verdade. | U |
| 042 | Contrato entregue como coleção do Postman (sem OpenAPI), executada por um teste contra a API real. | O documento pede um dos dois. | U |
| 002 | Webhook aceita o bloco opcional `identifiers`. | Viabiliza os níveis 2 e 3 da atribuição. | U |

## Histórico de mudanças

- **ADR-032 → ADR-034:** o histórico de sessões deixou de guardar o corpo bruto (gravava e-mail e telefone inválidos).
- **ADR-008 → ADR-024:** a autenticação foi reaberta só para `/support/*`.
- **ADR-037 → ADR-043:** "todo `code` diferente de 0 do TikTok é permanente" passou a tratar o 40100 como transitório.
- **ADR-041 → ADR-042:** o OpenAPI foi removido, e o contrato passou a ser a coleção do Postman.
