# Motor de Eleição Interativa para TikTok LIVE (fase 1 — sem interface visual)

Motor de jogo em TypeScript/Node.js: recebe presentes, curtidas e comandos de chat, cria **eleitores somente a partir de interações válidas**, registra votos de forma transacional, mantém o ranking em tempo real e publica eventos (WebSocket) para a interface futura. **Nenhuma interface visual foi desenvolvida.**

> **Situação da integração real:** o adaptador do TikTok LIVE está implementado e testado **somente contra uma conexão falsa e o simulador**. **Nenhuma conexão real com uma transmissão do TikTok foi feita ou validada.** Veja [Integração com o TikTok LIVE](#integração-com-o-tiktok-live).

## Arquitetura

```
 TikTok LIVE ──► TikTokLiveAdapter ─┐ (reconexão c/ backoff; normaliza p/ contrato interno)
 (biblioteca comunitária,          │
  isolada em src/sources)          ├──► ElectionEngine.ingest() ──► EventQueue (FIFO, escritor único)
 SimulatedSource/SimulationRunner ─┘                                      │
   (eventos FICTÍCIOS, simulated=true)                                    ▼
                                    validar → modo → eleição ativa → EventDeduplicator
                                                      │
                                       ┌──────────────┴─────────────── TRANSAÇÃO SQLite ──────────────┐
                                       │ events (UNIQUE dedupe_key) · GiftProcessor / LikeProcessor /  │
                                       │ ChatCommandProcessor · voters · votes (livro) · saldos        │
                                       └──────────────┬────────────────────────────────────────────────┘
                                          commit ok   ▼
                       CandidateService (memória derivada do livro) → RankingService
                                       │                    │
                                       ▼                    ▼
                                    EventBus ──► GameWsServer (somente leitura) ──► interface futura
                                       ▲
                       PresentationQueue (limite de animações, agrupamento, VoterAnimator)
                       → só muda o ESTADO do eleitor; nunca cria/altera votos
```

| Módulo | Arquivo | Papel |
|---|---|---|
| `TikTokLiveAdapter` | `src/sources/tiktokLiveAdapter.ts`, `inputNormalizer.ts` | Única parte que conhece a biblioteca; reconexão com espera progressiva + jitter |
| `GiftProcessor` | `src/giftProcessor.ts` | Regras de presentes, combos por delta, escolha do candidato |
| `LikeProcessor` | `src/likeProcessor.ts` | Acumulador persistente, incremental/cumulativo |
| `ChatCommandProcessor` | `src/chatCommandProcessor.ts` | `!votar <candidato>` |
| `ElectionEngine` | `src/electionEngine.ts` | Orquestra validação → transação → emissão |
| `CandidateService` / `RankingService` | `src/candidateService.ts`, `rankingService.ts` | Candidatos, ranking, desempate, verificação de integridade |
| `VoterService` / `PresentationQueue` | `src/voterService.ts`, `presentationQueue.ts` | Ciclo de vida do eleitor, fila de apresentação |
| `EventQueue` / `EventDeduplicator` | `src/eventQueue.ts`, `deduplicator.ts` | Serialização sem perda; deduplicação |
| `PersistenceService` | `src/persistence.ts` | SQLite (better-sqlite3), todo SQL fica aqui |
| `AdminConfigService` | `src/config.ts` | Configuração validada e persistida |
| `SimulationRunner` / `SimulatedSource` | `src/simulation/`, `src/sources/simulatedSource.ts` | Cenários reproduzíveis por semente |
| `HealthMonitor`, `EventBus`, `GameWsServer`, `Metrics`, `logger` | `src/*.ts` | Saúde, barramento, WebSocket, métricas, logs estruturados com redação de segredos |

### Garantias de projeto
- **Eleitores só nascem de interação**: não há temporizador, aleatoriedade nem espectador inventado em `src/` (exceto `src/simulation/`, que é fictício e marcado).
- **Voto = transação**: evento + eleitor + voto + saldo/progresso de combo gravam juntos ou não gravam. Memória (ranking) só é atualizada **depois** do commit, a partir do livro `votes`.
- **Animação não vota**: `PresentationQueue` só altera `voters.state`. Falha de animação → `failed`, voto intacto (`vote_confirmed`).
- **Idempotência**: `UNIQUE(election_id, dedupe_key)` no banco (sobrevive a reinício) + janela LRU em memória.
- **Nunca candidato aleatório**: destino = escolha registrada do espectador (ou regra explícita configurada). Sem destino: ignora ou registra participação sem votos.
- **Simulação ≠ real**: o motor tem `mode`; eventos `simulated` são recusados em `live` e vice-versa; snapshot/CLI exibem aviso de simulação; bancos separados (`data/simulation.db`, `data/live.db`).

### Regras implementadas
- **Presentes**: tabela editável (`gifts.rules`, por nome ou id). Rosa = 1 voto; outras linhas são **exemplos** editáveis. Desconhecido → `record_only` (registra, 0 votos) ou `default_votes`.
- **Eleitores por presente** (`gifts.voterMode`): `per_event` (padrão: 1 eleitor por evento lógico, votos = unidades × valor) ou `per_unit`.
- **Combos**: progresso persistido por `usuário|groupId|presente`. Cada evento conta só o **delta** sobre o já contado → início/atualização/fim, reenvios e atualizações fora de ordem nunca contam duas vezes. Eventos ≠ unidades ≠ eleitores ≠ votos (métricas separadas).
- **Curtidas**: limite padrão 1.000 (editável). Saldo preservado e persistido. `auto` usa o total cumulativo se vier (conta só o aumento; o 1º total vira referência; total ≤ último = ignorado), senão o lote incremental. Nome sempre “Eleitor das Curtidas” no acumulador global. Destino do voto: `none` (padrão: eleitor sem votos), `fixed_candidate`, ou `user_choice` (exige `accumulation=per_user`, onde a identidade é confirmada).
- **Escolha de candidato**: `!votar <comando>`; só vale para interações futuras; comando com `ts` mais antigo que a escolha atual é rejeitado.
- **Ranking**: votos válidos, % dos votos válidos, diferença p/ líder e p/ próximo, presentes, apoiadores. **Desempate**: mais votos → quem atingiu o total primeiro (menor `seq` do livro) → ordem de cadastro. `points` e `effects` são campos **separados** e não entram no ranking por votos.
- **Fila**: escritor único FIFO sem descarte; apresentação limitada por `maxConcurrent`, velocidade `speed`, e backlog > `groupThreshold` é agrupado em `voter.group` (votos intactos).

### Eventos publicados (EventBus / WebSocket)
`gift.processed`, `likes.threshold_reached`, `voter.created`, `voter.queued`, `voter.approaching`, `voter.voting`, `voter.completed`, `voter.rejected`, `voter.failed`, `voter.group`, `candidate.vote_received`, `candidate.ranking_changed`, `election.updated`, `election.finished`, `config.updated`, `source.status`, `health.status`. Cada mensagem: `{ seq, type, ts, data }`; ao conectar, o cliente recebe `{type:'snapshot'}`. O WebSocket é **somente leitura** (mensagens do cliente são ignoradas), em `127.0.0.1`.

**Sincronização visual:** `candidate.vote_received`/`election.updated` indicam o voto **já confirmado**. Para que o placar só suba quando o personagem votar, a interface deve guardar o `ranking` e exibi-lo em `voter.voting` do `voterId` correspondente (o `voterId` vai em `candidate.vote_received`).

## Como usar

Requisitos: Node ≥ 20 (testado com Node 22.22). `npm install`

| Comando | O que faz |
|---|---|
| `npm test` | Roda os testes (Vitest) |
| `npm run typecheck` / `npm run build` | Verificação de tipos / compilação |
| `npm run loadtest` | Teste de carga (≥10.000 eventos); grava `docs/loadtest-result.json` |
| `npm run sim` | Motor em **simulação** (banco `data/simulation.db`, WS na porta 8787). Opções: `-- --seed=42 --events=300 --paceMs=50 --port=8787` |
| `TIKTOK_USERNAME=@usuario npm run live` | Modo **live** (não validado, veja abaixo). Opcional: `TIKTOK_SIGN_API_KEY` |

Credenciais só via variáveis de ambiente; o logger redige chaves com `token|cookie|session|api_key|authorization|secret|sign`. Cookies de sessão **não** são usados.

Configuração (candidatos, comandos, presentes, limite de curtidas, políticas) é validada e persistida: ver `src/config.ts` (`DEFAULT_CONFIG`) e `engine.admin.update({...})`.

## Resultados reais (executados neste ambiente)

### Testes automatizados — `npm test`
```
Test Files  2 passed (2)
     Tests  54 passed (54)
```
Cobrem os 20 testes obrigatórios (nomes “Teste N — …” em `test/engine.test.ts` e `test/sources.test.ts`) + extras: transação revertida em falha interna, fila de apresentação (limite de concorrência e agrupamento), sequência de eventos do barramento, mudança de ranking, validação de configuração, WebSocket, normalizador, e 3 cenários de simulação (curtidas incremental/cumulativa/ambas) com duplicados, inválidos, eventos fora de ordem, quedas e **reinícios do processo**, comparando o motor com um **oráculo independente** do gerador.

Checagem de sensibilidade: três defeitos foram introduzidos de propósito (combo recontando, cumulativo contando o total inteiro, deduplicação desligada) e a suíte falhou em cada um (6, 4 e 5+ testes); código revertido e suíte voltou a 54/54.

### Teste de carga — `npm run loadtest` (seed 2024; arquivo `docs/loadtest-result.json`)
Cenário: 10.000 eventos lógicos → **14.270 enviados** (combos geram vários eventos), SQLite em arquivo (WAL), rajadas de 500 simultâneos, 6 quedas simuladas da fonte, **2 reinícios** do motor, 580 duplicados e 295 inválidos injetados, atualizações de combo fora de ordem.

| Indicador | Valor |
|---|---|
| Eventos enviados pelo simulador | 14.270 |
| Perdidos com a fonte desconectada (sem garantia de entrega) | 24 |
| Entregues ao motor | 14.246 |
| Processados (alteraram estado: comando, voto, saldo) | 8.833 |
| Rejeitados por regra (sem candidato: 3.243; presente desconhecido: 308) | 3.551 |
| Inválidos (injetados: 295) | 295 |
| Duplicados ignorados (injetados: 580) | 580 |
| Sem novidade (combo/total já contado) | 987 |
| Falhas internas | 0 |
| Eventos de presente / unidades de presente contadas | 9.512 / 11.405 |
| Votos válidos totais | 17.530 (c1 6.819 · c2 5.633 · c3 5.078) |
| Eleitores criados | 5.781 (4.974 de presentes · 807 de curtidas) |
| Curtidas contabilizadas / saldo final | 807.186 / 186 (807 eleitores) |
| Tempo total / vazão | 2,19 s / ≈ 6.500 eventos/s (execuções variam ~6.500–6.700) |
| Maior profundidade da fila | 499 |
| Integridade do ranking (memória × livro de votos × soma dos eleitores, % = 100) | OK |
| Concordância com o oráculo (votos por candidato, eleitores, curtidas, saldo, unidades) | OK |

(14.246 = 8.833 + 3.551 + 295 + 580 + 987.) Vazão medida com presentação instantânea e SQLite local; **não** representa o desempenho em outra máquina nem com animações reais.

## Integração com o TikTok LIVE

- Biblioteca: [`tiktok-live-connector`](https://www.npmjs.com/package/tiktok-live-connector) **2.5.0** (comunitária, **não oficial**; última modificação no npm em 2026-09-16). Isolada em `src/sources/`; substituível implementando `LiveConnection` ou `EventSource`.
- Contrato lido do README/tipos da v2.5.0: eventos `gift`, `like`, `chat`, `disconnected`, `streamEnd`, `error` (confirmados como constantes `WebcastEvent`/`ControlEvent` da biblioteca instalada); presentes com `giftType 1` repetem eventos com `repeatCount` crescente e um final com `repeatEnd`; `like` traz `likeCount` e `totalLikeCount`. O README avisa que, em lives grandes, o evento de curtidas **nem sempre é disparado**.
- **Não validado em transmissão real:** nenhum teste conectou ao TikTok. Os aliases de campos que não estão no README (`common.msgId`, `groupId`, `user.userId/id`, `count`/`total`, `content`) vêm dos tipos protobuf e podem divergir. O id da Rosa (`5655`) é o valor comumente citado pela comunidade, não confirmado. **Antes de usar em produção, rode em uma live de teste e confira os campos reais** (a biblioteca emite `rawData`/`decodedData` para inspeção).
- A biblioteca pode exigir serviço de assinatura de terceiros (Euler Stream; `signApiKey`), e seu uso depende dos termos da plataforma e de terceiros. Opções que enviam cookies/sessão ao serviço (`authenticateWs`, `useMobile`) **não** são usadas por este projeto.
- Importar a biblioteca e construir `TikTokLiveConnection` funciona sem rede (verificado); `connect()` real não foi executado.

## Falhas: o que se recupera e o que não

| Situação | Comportamento |
|---|---|
| Reinício do processo | **Recupera**: votos, escolhas, saldos, referência cumulativa e combos estão no SQLite; eleitores pendentes são reapresentados (`recoverPending`); deduplicação continua valendo (UNIQUE no banco). |
| Erro no meio do processamento | **Recupera**: transação revertida; o mesmo evento pode ser reprocessado. |
| Queda de conexão | Reconexão automática (1s → 60s, ×2, jitter 20%). **Eventos emitidos durante a queda são perdidos** — não há garantia de entrega e a biblioteca não reenvia histórico. Exceção: com `totalLikeCount`, o aumento ocorrido na queda é contabilizado na volta. |
| Presente duplicado sem `eventId` e sem `ts` | **Não detectável** (só combos têm proteção por delta). |
| Falha/queda da biblioteca, mudança de protocolo, bloqueio pela plataforma | **Depende da biblioteca e do TikTok**; o motor continua íntegro, mas não recebe eventos. |
| Falha de animação | Voto preservado; eleitor `failed`. |

## Limitações conhecidas
- Conexão real não validada (acima). Valores de presentes além da Rosa são exemplos.
- `TimerAnimator` é um substituto por temporizador: `voter.completed` hoje significa “tempo de animação passou”, não confirmação da interface (não há ACK da UI nesta fase).
- Agrupamento visual: eleitores agrupados pulam `approaching`/`voting` individuais (vão direto a `completed`, com `grouped: true`).
- Total cumulativo de curtidas é da **sala**; o primeiro total observado é só referência. Em modo `per_user` usa-se apenas `likeCount`. O modo `per_user` é coberto por teste unitário, não pelo teste de carga.
- SQLite com escritor único (suficiente para a escala testada). Migrar para PostgreSQL exige portar `PersistenceService` (API hoje síncrona) para assíncrona. Durabilidade: `synchronous=NORMAL` (WAL) pode perder as últimas transações em queda do sistema operacional (`synchronous: 'FULL'` disponível).
- O oráculo do teste de carga foi escrito pelo mesmo autor do motor: protege contra regressões e erros de implementação, não contra uma interpretação equivocada das regras.
- Privacidade: guarda `userId`, nome exibido e o evento normalizado (sem tokens/cookies). Não há rotina de expurgo/anonimização ainda.
- WebSocket sem autenticação (somente `127.0.0.1`); não exponha à rede sem camada de proteção.
- Eleitores já na fila quando a eleição encerra continuam sendo apresentados (os votos já estavam confirmados).

## Próximos passos (interface)
1. Cliente WebSocket (`ws://127.0.0.1:8787`): ler `snapshot`, depois aplicar eventos por `seq` (detectar lacunas e pedir novo snapshot reconectando).
2. Cena: urna, ponto de entrada, spawn de personagem em `voter.queued`, nome sobre a cabeça (`displayName`), caminhada em `voter.approaching`, ação de votar em `voter.voting`, saída em `voter.completed`; `voter.group` → multidão.
3. Implementar `VoterAnimator` real (ou ACK via WS) para que `approaching/voting/completed` reflitam a animação real; manter placar atualizado em `voter.voting`.
4. Painel: ranking (`election.updated`), ultrapassagens (`candidate.ranking_changed`), rejeições (`voter.rejected`), aviso de simulação (`snapshot.notice`).
5. Validar o adaptador numa live de teste real e ajustar `inputNormalizer`.
6. Painel admin sobre `AdminConfigService` (limite de curtidas, tabela de presentes, políticas).
