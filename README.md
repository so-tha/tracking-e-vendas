# Tracking Hub

Backend de tracking e vendas: captura sessões de navegação, recebe pedidos por webhook, atribui cada venda à sessão correta (com a origem de cada dado auditável) e envia a conversão para **Meta, Google, TikTok, UTMify e RedTrack** (simulados), sem duplicar, com retry controlado e um endpoint de suporte para diagnóstico e reprocessamento.

Node.js 24, TypeScript, Express 5, Prisma 7, PostgreSQL 17, fila em tabela do PostgreSQL, Vitest. **Limitações conhecidas:** [docs/06-LIMITACOES-CONHECIDAS.md](docs/06-LIMITACOES-CONHECIDAS.md).

## Como executar

Requisitos: Docker com Docker Compose.

```bash
cp .env.example .env          # troque os segredos de SUPPORT_API_KEYS
docker compose up --build     # PostgreSQL, migrations, API (porta 3333) e worker
curl localhost:3333/health    # {"status":"ok","database":"up"}
```

As portas podem ser trocadas com `API_PORT` e `DB_PORT`. Nenhuma credencial real de provedor é necessária: as integrações rodam em modo simulado (`PROVIDER_MODE=simulated`).

### Desenvolvimento e testes (Node.js `^22.18`, `^24.11` ou `>=26`)

```bash
npm install
docker compose up -d db       # só o banco
npm run prisma:deploy && npm run prisma:generate
npm run dev                   # API
npm run dev:worker            # worker, em outro terminal
npm test                      # todos os testes (precisa do banco)
npm run test:unit             # só os unitários, sem banco
npm run typecheck && npm run build
```

## Endpoints

Contrato e exemplos na coleção do Postman: [postman/tracking-hub.postman_collection.json](postman/tracking-hub.postman_collection.json). Importe-a e defina a variável `apiKey`.

| Método e rota | Autenticação | Para quê |
|---|---|---|
| `GET /health` | — | Estado da API e do banco |
| `POST /tracking/sessions` | — | Registra ou complementa uma sessão (nunca sobrescreve evidência) |
| `POST /webhooks/orders` | — | Recebe o pedido, responde `202` e processa de forma assíncrona |
| `GET /support/orders/:orderId/tracking` | `X-API-Key` | Qual valor foi associado à venda, de onde veio e exatamente o que foi enviado |
| `POST /support/orders/:orderId/reprocess` | `X-API-Key` | Reprocessa o que não foi entregue, sem repetir entregas |

Valores monetários viajam na **menor unidade da moeda** (`25500` USD = US$ 255,00). As chaves de suporte ficam em `SUPPORT_API_KEYS` (`operador:segredo`), e o operador registrado vem sempre da configuração da chave.

## Como funciona

1. **Sessão:** o checkout registra a sessão com `customFields` e identificadores. Novos envios só completam o que está vazio. Valores divergentes viram conflito registrado, nunca sobrescrita.
2. **Webhook:** o evento e um job são gravados na mesma transação. O mesmo `eventId` ou `orderId` nunca gera um segundo pedido.
3. **Atribuição** (worker): em ordem, `sessionId`, identificador próprio (`utmifyId`, `redtrackClickId`), click ID e, por fim, e-mail do cliente numa janela de 24h. Com mais de uma sessão possível no mesmo nível, a venda fica **não atribuída**. O resultado é um snapshot imutável com a origem de cada dado.
4. **Conversões:** uma por provedor. Sem o identificador exigido pelo provedor, `SKIPPED` com motivo. Erros transitórios têm retry com backoff, e os permanentes param. Cada tentativa grava o request enviado.
5. **Suporte:** visão explicada e mascarada do pedido, e reprocessamento auditável.

Detalhes e diagramas em [docs/03-FLUXO-DO-SISTEMA.md](docs/03-FLUXO-DO-SISTEMA.md). Decisões em [docs/02-DECISOES-ARQUITETURAIS.md](docs/02-DECISOES-ARQUITETURAIS.md).

## Conhecimento técnico

### Pixel no navegador x evento server-side
O **pixel** é um script no navegador que envia o evento direto à plataforma, com os cookies dela. É o que captura o contexto do clique, mas depende do navegador: bloqueadores, recusa de consentimento ou a página fechada antes do disparo fazem o evento se perder. O **evento server-side** (Conversions API da Meta, Events API do TikTok, Data Manager API do Google, postbacks) sai do backend depois que o pagamento é confirmado. É confiável e traz o valor real do pedido, mas só tem o contexto do navegador se ele tiver sido capturado antes (identificadores, IP, user agent). O recomendado é usar os dois e **deduplicar**.

### Para que servem os identificadores

| Identificador | O que é | Uso aqui |
|---|---|---|
| `fbclid` | ID do clique em anúncio da Meta, na URL de destino | Evidência de clique (nível 3) |
| `fbc` | Cookie `_fbc` da Meta: `fb.1.<timestamp>.<fbclid>`. O clique, guardado no navegador | Evidência de clique e enviado à Meta (sem hash) |
| `fbp` | Cookie `_fbp` da Meta: identifica o **navegador**, não o clique | Só enviado à Meta. Nunca atribui sozinho, porque várias sessões o compartilham |
| `gclid` | ID do clique no Google Ads (auto-tagging) | Evidência de clique e enviado ao Google |
| `gbraid`, `wbraid` | Usados pelo Google no lugar do `gclid` em tráfego iOS sujeito ao ATT, de forma agregada. Com vários presentes, o Google usa `gclid`, depois `wbraid`, depois `gbraid` | Evidência de clique e enviados ao Google |
| `ttclid` | ID do clique em anúncio do TikTok | Evidência de clique e enviado ao TikTok |
| `ttp` | Cookie `_ttp` do TikTok: identifica o navegador | Só enviado ao TikTok. Nunca atribui sozinho |

### Como Meta, Google e TikTok deduplicam
- **Meta:** mesmo `event_name` e mesmo `event_id` no Pixel (`eventID`) e na Conversions API, em até 48h. Alternativa: `fbp` ou `external_id`, que só funciona se o evento do navegador chegar primeiro.
- **Google:** `transactionId` (Data Manager API) ou `order_id` (Google Ads), únicos por ação de conversão. Deduplicam contra as conversões da tag do Google.
- **TikTok:** mesmo `event` e mesmo `event_id`, em até 48h. Entre Pixel e servidor, a deduplicação vale para eventos que chegam depois de 5 minutos.
- **Aqui:** o backend usa o `orderId` como `event_id` e `transactionId`. **O checkout precisa usar o mesmo `orderId` como `eventID` do Pixel**, senão a compra conta duas vezes.

### Por que o tracking se perde
- **Bloqueadores** impedem o script do pixel de carregar ou bloqueiam os domínios das plataformas.
- **Cookies:** navegadores limitam a vida dos cookies primários (por exemplo, o ITP do Safari), bloqueiam cookies de terceiros, e o visitante pode recusar o consentimento.
- **Redirecionamentos:** gateways de pagamento, encurtadores e reescritas de URL removem `fbclid`, `gclid` e `ttclid`, e trocar de domínio no checkout perde os cookies.
- **Troca de dispositivo:** clique no celular e compra no computador não compartilham cookies. Só um dado do cliente (e-mail) liga os dois.

Por isso o sistema guarda os identificadores no backend assim que a sessão é registrada, pede o `sessionId` no webhook e tem níveis de evidência mais fracos como recurso.

### Como investigar divergências entre pedido, UTMify e RedTrack
Comece por `GET /support/orders/:orderId/tracking`. Ele responde, em ordem:
1. **O pedido existe e foi processado?** Veja `events` (`RECEIVED`, `DUPLICATE_ORDER`, `IGNORED_UNSUPPORTED`).
2. **Foi atribuído, e a qual sessão?** Veja `attribution` (nível, explicação, alertas) e `trackingData` (cada valor com a origem).
3. **Cada provedor recebeu?** Em `conversions`: `SKIPPED` mostra o motivo (por exemplo, sem `redtrackClickId` ou sem `utmifyId`), e `FAILED_PERMANENT` mostra o erro.
4. **O que foi enviado, exatamente?** `sentPayload` e `attempts[].request`: confira `clickid`, `sck`, valor (`sum` em decimal, `priceInCents` em centavos), moeda, `rdtk_event_id` e o horário em UTC.

Causas comuns: o identificador esperado nunca chegou (tracking perdido), o tipo de conversão no RedTrack difere em maiúsculas, o modo de duplicatas do RedTrack não está configurado, o pedido tem mais de 7 dias para a UTMify, a moeda é diferente da conta, ou houve reembolso (não é propagado).

### Como evitar atribuir ou enviar para o afiliado errado
- O primeiro valor de cada campo da sessão vale (**first-write-wins**). Um reenvio com outro `affiliateCode` vira conflito registrado, nunca sobrescrita.
- `customFields` é **atômico**: a campanha de uma fonte e o afiliado de outra nunca se misturam.
- Com mais de uma sessão possível, a venda **não é atribuída**. Nada é escolhido "no palpite".
- Evidências contraditórias geram o alerta `ATTRIBUTION_CONFLICT`, mantendo a sessão de nível mais alto.
- O afiliado só é enviado quando a atribuição foi pelos níveis 1 a 3 (evidência forte), nunca pelo e-mail.
- A atribuição é congelada: nada a altera depois que as conversões são criadas.

### Como normalizar e proteger dados pessoais enviados aos provedores
- **Normalizar antes do hash, conforme cada provedor.** E-mail sempre sem espaços e em minúsculas. O Google também remove pontos e `+sufixo` do Gmail. Telefone em E.164 (Google, TikTok) ou só dígitos com o código do país (Meta). O hash é SHA-256 em hexadecimal. Um hash de texto normalizado errado não casa, e a requisição ainda responde 200.
- **Nunca fazer hash de identificadores** (`fbc`, `fbp`, `gclid`, `ttclid`, `ttp`): com hash eles ficam inúteis.
- **Enviar o mínimo:** o RedTrack não recebe nenhum dado pessoal. A UTMify exige e-mail em claro pelo contrato (risco declarado).
- **Proteger dentro do sistema:** logs com redação de e-mail, telefone e chaves. O suporte vê tudo mascarado. Credenciais nunca entram nos payloads gravados.

## Documentação

| Documento | Conteúdo |
|---|---|
| [01-PLANEJAMENTO](docs/01-PLANEJAMENTO.md) | Requisitos, arquitetura, modelagem, etapas e rastreabilidade |
| [02-DECISOES-ARQUITETURAIS](docs/02-DECISOES-ARQUITETURAIS.md) | ADRs, inclusive os contratos dos provedores (confirmado x suposição, ADR-037) |
| [03-FLUXO-DO-SISTEMA](docs/03-FLUXO-DO-SISTEMA.md) | Funcionamento ponta a ponta, com diagramas |
| [06-LIMITACOES-CONHECIDAS](docs/06-LIMITACOES-CONHECIDAS.md) | O que não está pronto para produção, e como resolver |
