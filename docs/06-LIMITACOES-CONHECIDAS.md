# 06 — Limitações Conhecidas

Tudo o que o projeto **não** faz, faz de forma simplificada ou assume sem confirmação, com o impacto e o caminho para resolver. Mantido aqui, e não no README, por decisão do usuário (ADR-041).

**Legenda de gravidade para produção:** **Alta** = bloqueia uso real. **Média** = aceitável com monitoramento. **Baixa** = melhoria.

## 1. Segurança

| # | Limitação | Impacto | Gravidade | Como resolver | Ref. |
|---|---|---|---|---|---|
| S1 | `POST /webhooks/orders` não tem autenticação (HMAC). | Qualquer pessoa pode forjar uma venda paga e disparar conversões para os provedores. | **Alta** | Assinatura HMAC do emissor, validada antes de gravar. | ADR-008 |
| S2 | `POST /tracking/sessions` é público e sem autenticação. | É possível criar sessões falsas. O first-write-wins impede sobrescrever uma sessão existente, mas não impede criar sessões com o e-mail de um cliente para tornar a venda dele **ambígua** no nível 4. | Média | Token assinado emitido pelo checkout por sessão, e rate limit por IP. | ADR-008, ADR-014, ADR-035 |
| S3 | `/support/*` usa chave estática por operador, sem limite de tentativas, sem expiração e sem TLS embutido. | Força bruta possível sem rate limit. A chave trafega em cabeçalho simples. | **Alta** | Rate limit, HTTPS obrigatório, SSO/JWT com papéis ou mTLS, rotação de chaves. | ADR-024, ADR-040 |
| S4 | A UTMify recebe e-mail e telefone em **texto claro** (exigência do contrato dela). | Dados pessoais saem do sistema sem hash. | Média | Confirmar com a UTMify, ou enviar só o necessário, com base legal documentada. | ADR-038 |
| S5 | E-mail e telefone ficam em claro no banco (`Order`, `TrackingSession`, `Conversion.eventSnapshot`). Sem criptografia em repouso. | Vazamento do banco expõe dados pessoais. | Média | Criptografia de colunas, ou cofre de dados pessoais. | ADR-036 |
| S6 | Sem política de retenção e expurgo de dados (LGPD). | Dados pessoais são guardados indefinidamente. | Média | Prazo de retenção e rotina de expurgo e anonimização. | — |

## 2. Atribuição

| # | Limitação | Impacto | Gravidade | Como resolver | Ref. |
|---|---|---|---|---|---|
| A1 | Uma sessão que chega **depois** do webhook não corrige a venda (atribuição congelada). | Vendas com tracking atrasado ficam não atribuídas para sempre. | Média | Reatribuição versionada, permitida só se nenhuma conversão foi entregue. | ADR-010, ADR-023 |
| A2 | A janela de 24h usa o `firstSeenAt` da sessão. | Quem chegou há mais de 24h e voltou para comprar não é atribuído pelo nível 4. | Baixa | Ajustar `TRACKING_MATCH_WINDOW_HOURS` ou usar outra referência temporal. | ADR-035 |
| A3 | Se o checkout gerar um **novo `sessionId` a cada carga de página** com o mesmo click ID, duas sessões compartilham o `fbclid`, e a venda sem `sessionId` no webhook fica não atribuída (ambiguidade). | Menor taxa de atribuição. | Média | O checkout deve manter o `sessionId` estável e enviá-lo no webhook. | ADR-020 |
| A4 | `fbp` e `ttp` nunca atribuem sozinhos. | Venda cuja única evidência é um cookie de navegador fica não atribuída. | Baixa | Comportamento escolhido de propósito (evita atribuição errada). | ADR-013 |
| A5 | `orderId` é único **globalmente** (sem conceito de lojista). | Não serve para vários lojistas no mesmo banco. | Baixa | Unicidade composta (lojista + pedido). | ADR-015 |
| A6 | Correspondência por cliente usa só o e-mail (o webhook não traz telefone). | Menos evidência no nível 4. | Baixa | Aceitar telefone no webhook. | ADR-003 |

## 3. Integrações com provedores

| # | Limitação | Impacto | Gravidade | Como resolver | Ref. |
|---|---|---|---|---|---|
| I1 | **Todos os provedores são simulados.** Nenhuma integração real foi feita ou testada. | O comportamento real (respostas, erros, limites) pode diferir. | **Alta** | Testar com contas de teste de cada provedor antes de produção. | ADR-036 |
| I2 | **TikTok:** a documentação oficial do endpoint não pôde ser lida. Endpoint, campos, normalização e nome do evento vêm de fontes secundárias. Só o código 40100 (limite de requisições) é confirmado oficialmente; os demais códigos diferentes de 0 são tratados como permanentes por suposição. O limite diário pede espera até o dia seguinte, mas o sistema repete em 5 minutos. | O payload pode estar errado, e um código repetível desconhecido viraria falha permanente (recuperável pelo reprocessamento). | **Alta** | Confirmar no portal oficial do TikTok a lista de códigos. | ADR-037, ADR-043 |
| I3 | **UTMify:** o webhook não traz nome, método de pagamento, produtos nem taxas. Usamos valores padrão (`Cliente`, `credit_card`, um produto com o valor total, taxas zero, `createdAt` igual ao recebimento). `sck` recebe o `utmifyId` sem confirmação. | O relatório da UTMify mostra dados genéricos e comissão igual ao valor bruto. | **Alta** | Incluir esses dados no webhook, ou confirmar com a UTMify. | ADR-037 |
| I4 | **Meta:** `client_user_agent` (exigido para eventos web) e `client_ip_address` não são capturados. Versão da API (`v27.0`) e `custom_data` são suposições. | Pior correspondência, ou rejeição pela Meta. | **Alta** | Capturar IP e user agent do visitante no `/tracking/sessions`. | ADR-037 |
| I5 | **Google:** o `consent` não é enviado (não temos o dado). Nomes de campos dentro de `userData` e `operatingAccount` não foram confirmados. | A conversão pode não ser atribuída em regiões que exigem consentimento. | Média | Capturar o consentimento no checkout e enviá-lo. | ADR-037 |
| I6 | **RedTrack:** formato da URL do postback vem de guias de parceiros. Tipo `Purchase` precisa existir na conta. Sem parâmetro de moeda. A deduplicação por `rdtk_event_id` exige um modo configurado na conta. | Postback ignorado ou com valor na moeda errada. | Média | Confirmar no RedTrack e configurar o modo de duplicatas. | ADR-037 |
| I7 | O `affiliateCode` só vai para a Meta (`custom_data`). UTMify e RedTrack não têm campo documentado. | O afiliado não chega a essas plataformas. | Média | Confirmar um campo oficial em cada uma. | ADR-018, ADR-037 |
| I8 | A deduplicação com o Pixel depende de o checkout usar o **`orderId` como `eventID`** do Pixel (Meta e TikTok). | Sem isso, a mesma compra pode contar duas vezes (navegador e servidor). | **Alta** | Alinhar com o checkout. | ADR-037 |
| I9 | Entrega **pelo menos uma vez**: se o processo cair entre o envio e a gravação, a conversão é reenviada. | Depende da deduplicação de cada provedor. | Baixa | Já mitigado pelas chaves de deduplicação. | ADR-036 |
| I10 | Os formatos de `fbc` e `fbp` não são validados (os exemplos do documento original não seguem o formato oficial). | Um valor malformado é enviado como veio. | Baixa | Validar em produção, com dados reais. | ADR-039 |

## 4. Escopo de negócio

| # | Limitação | Impacto | Gravidade | Como resolver | Ref. |
|---|---|---|---|---|---|
| N1 | Só `ORDER_PAID` é processado. Reembolso e chargeback são registrados e ignorados. | Conversões não são estornadas nos provedores. | Média | Tratar `ORDER_REFUNDED` e `ORDER_CHARGEDBACK`. | ADR-005 |
| N2 | Sem cálculo de comissão (o documento não pede nem define a regra). O afiliado da venda é gravado uma vez por pedido. | Quem paga comissão precisa calcular a partir do `affiliateCode` e do nível de evidência. | Baixa | Modelar a comissão quando houver regra definida. | ADR-006 |
| N3 | Sem conversão cambial. | Relatórios em moedas diferentes não são somáveis. | Baixa | Fora do escopo por decisão. | ADR-007 |

## 5. Operação

| # | Limitação | Impacto | Gravidade | Como resolver | Ref. |
|---|---|---|---|---|---|
| O1 | Fila em tabela do PostgreSQL com polling. Cada worker processa um job por vez. | Vazão limitada. Mais volume exige mais workers. | Baixa | Escalar workers, ou trocar por BullMQ pela interface `JobQueue`. | ADR-026 |
| O2 | Sem métricas, alertas nem tracing distribuído. Só logs. | Falhas em massa (por exemplo, um provedor fora do ar) só são vistas nos logs ou pelo suporte. | Média | Métricas por provedor (taxa de falha, tempo), alertas e dashboard. | — |
| O3 | O reprocessamento não acelera retries já agendados (até 1h de espera). | Depois de uma queda de provedor, a recuperação respeita o backoff. | Baixa | Ação explícita de "tentar agora", se o suporte precisar. | ADR-040 |
| O4 | A visão de suporte carrega o pedido inteiro com todas as tentativas. | Adequada para consulta pontual, não para uso em massa. | Baixa | Paginação das tentativas. | ADR-040 |
| O5 | Um job abandonado e retomado pode executar duas vezes. | Os handlers são idempotentes, então não duplica dados. | Baixa | Já mitigado. | ADR-033 |

## 6. Qualidade e testes

| # | Limitação | Impacto | Gravidade | Como resolver | Ref. |
|---|---|---|---|---|---|
| T1 | Não há pipeline de integração contínua. | Os testes só rodam quando alguém os executa. | Média | CI com PostgreSQL de serviço, `tsc`, testes e build da imagem. | — |
| T2 | Os testes de mutação foram feitos manualmente, etapa a etapa, e não são automatizados. | Novas mudanças não são verificadas assim automaticamente. | Baixa | Ferramenta de mutação (por exemplo, Stryker) na CI. | — |
| T3 | Sem testes de carga. | O comportamento sob volume é desconhecido. | Média | Teste de carga do webhook e da fila. | — |
| T4 | Os testes de integração exigem o PostgreSQL rodando. | `npm test` falha sem o banco (`npm run test:unit` roda sem ele). | Baixa | Documentado no README. | ADR-029 |
