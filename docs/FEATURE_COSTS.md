# Hubcode — Feature × Infra × Cost

Estimativa de custo de infraestrutura por feature. Números de referência usados:

- **Postgres gerenciado** (Neon / Supabase / Railway): ~$0.25/GB-mês storage, ~$0 por query em tiers baixos.
- **S3** (ou equivalente): $0.023/GB-mês storage + $0.09/GB egress.
- **Relay bandwidth** (self-hosted em VPS): ~$0.01/GB ao custo bruto; ~$0.02/GB se usar egress de cloud.
- **LiveKit self-hosted** (nosso caso): custo = VPS/K8s do SFU + bandwidth egress. Referência: ~$0.0005–0.001 /participant-minute em média (amortizando 1 VPS de ~$40/mês entre todos os usuários) + egress real. Muito mais barato que LiveKit Cloud.
- **Push** (APNS/FCM): grátis até escala MAU alta; ~$0 prático.
- **Stripe**: 2.9% + US$ 0.30 por cobrança (cobrado só quando há venda).
- **Cron / compute de rotinas**: ~$0 quando curtas; cada execução ≈ custo de CPU-minute do daemon do usuário (grátis pra você quando roda local). Se for "scheduled remote agents" servidos por você, ~$0.005/min de VM compartilhada.
- **Colyseus** (WS rooms): desprezível; memória + CPU de um Node.js. ~$0 por usuário em workloads normais.
- **MAU (infra fixa amortizada)**: ~$0.10–0.30/MAU num serviço maduro (monitoring, auth-server, CI, backups).

**Custos marcados "$0" significam "zero marginal operacional" (roda no daemon/máquina do usuário).** A convenção é mostrar custo aproximado *por usuário ativo/mês* ou *por uso*, o que fizer mais sentido.

---

## 1. Ciclo de vida do agente

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Run agent | daemon local (CPU/RAM do usuário); nenhum cloud | **$0** (infra sua) |
| Resume agent | idem | **$0** |
| Refresh agent | idem | **$0** |
| Archive agent | Postgres metadata (~1 KB/linha) | **~$0 / usuário-mês** |
| Delete agent | Postgres delete | **~$0** |
| Multi-provider (Claude/Codex/OpenCode) | daemon local; keys do usuário (BYOK) | **$0** |
| Provider snapshot | WS call, sem persist | **$0** |
| Agent modes / model / thinking / features | WS + registry local | **$0** |
| Message streaming | relay bandwidth se remoto (~2–10 KB/token) | **~$0.01–0.05 / hora ativa** (relay) |
| Permission requests | WS mensagens curtas | **$0** |
| Abort / cancel | WS | **$0** |
| Wait-for-finish | WS long-poll | **$0** |
| Activity log | Postgres (~200 B/evento) | **~$0.01 / usuário-mês** |
| Agent timeline | Postgres + blob store (tool results) | **~$0.02 / usuário-mês** |

## 2. Acesso remoto

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Relay protocol (E2E) | bandwidth entre device ↔ daemon | **$0.01–0.02 / GB** → ~$0.05–1.00 / usuário-mês (depende de uso) |
| Connection codes / QR pairing | Postgres (token efêmero) | **~$0** |
| Device pairing | Postgres (device_tokens) | **~$0** |
| Multi-client simultâneo | N × WS conexões na relay | escala linear; cada WS idle custa ~nada; ativa entra no relay bandwidth |
| Host switching | config local | **$0** |
| Daemon health checks | heartbeat WS (bytes pequenos) | **~$0** |

## 3. Chat / Comunicação

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Org channels | Postgres (mensagens, ~500 B cada) | **~$0.05 / usuário-mês** em usuários médios |
| Direct messages | Postgres | idem |
| Threads | Postgres (parent_id index) | idem |
| Reactions | Postgres tabela N:M | **~$0** |
| Mentions | Postgres + push trigger | **~$0** |
| Markdown rendering | client-side | **$0** |
| Rich attachments (imagem/vídeo/arquivo) | **S3 + egress** | **~$0.02–0.20 / usuário-mês** (heavy users podem estourar) |
| Typing indicators | Colyseus (sem persist) | **$0** |
| Message history paginação | Postgres read | **~$0** |
| Edit / delete / pin | Postgres update | **~$0** |
| Org presence (Colyseus) | WS room em memória | **~$0** |
| Voice notes | S3 (áudios ~100 KB/nota) | **~$0.01 / usuário-mês** |
| Quoted messages | Postgres foreign key | **$0** |
| Image lightbox / video thumbnails | S3 egress (thumbnails cacheados) | **incluso em anexos** |

## 4. Shared sessions / Pair programming

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Invite flow + share links | Postgres (share_token) | **~$0** |
| Access levels (read_only/full_access) | Postgres flag | **$0** |
| LiveKit video/áudio (**self-hosted**) | SFU VPS fixo + **egress bandwidth real** (~0.5–2 Mbps/participante em A/V) | **~$0.03–0.06 / hora-participante** (só egress) + custo fixo do SFU amortizado. ~10× mais barato que LiveKit Cloud |
| Session chat dedicado | Colyseus em memória | **$0** |
| FIFO queue mensagens | Colyseus | **$0** |
| Participant presence / cursors / selection rects / drawing | Colyseus | **$0** |
| Owner controls (ejetar / revogar) | Colyseus + Postgres | **$0** |

> **Self-hosted:** uma sessão de 1h com 3 participantes ≈ $0.10–0.18 de egress (depende do datacenter). SFU fixo (~$40/mês em 1 VPS dedicada) amortiza linearmente. Ainda é o maior item variável, mas não impõe cap agressivo no free — pode ser generoso.

## 5. Workspaces / Projects

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Project detection | filesystem scan local | **$0** |
| Git remote tagging | local git | **$0** |
| Worktrees (hubcode-worktree) | daemon local + disk do usuário | **$0** |
| Workspace list / switch | WS + registry local | **$0** |
| Team projects | Postgres | **~$0** |
| Workspace share | Postgres + Colyseus room | **~$0** |
| Project metadata (icon, nome, tags) | Postgres + S3 (icon) | **~$0** |

## 6. Code indexing

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| CRG subprocess | **roda local no daemon do usuário** | **$0** |
| MCP tools | local | **$0** |
| Embedding providers (hubcode-local) | CPU local (ONNX) | **$0** |
| Embedding providers (openai-compat) | API do usuário (BYOK) | **$0** pra você |
| Per-workspace opt-in | Postgres flag | **$0** |
| FS watchers | daemon local | **$0** |
| Install / detect flow | WS + subprocess local | **$0** |
| Progress bar / indexBytes / process-state push | WS (bytes pequenos) | **$0** |

> Indexing é **100% local** — ótimo candidato a estar no free sem medo.

## 7. Library (Skills & MCP Marketplace)

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Browse skills / MCP | auth-server + Postgres cache | **~$0** |
| Catálogo externo (PulseMCP/Smithery/skills.sh) | fetch cache + Postgres | **~$0.01 / usuário-mês** |
| Install / Sync pra CLI | local (escreve em ~/.agent/) | **$0** |
| Scopes (user/org/workspace) | Postgres | **$0** |
| Publish | Postgres + (opcional) storage de docs/assets | **~$0** (baixo volume) |
| Transport-aware (stdio/HTTP/SSE) | config JSON | **$0** |

## 8. Voice / Dictation

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Voice mode (full-duplex) | STT/TTS provider (normalmente BYOK) | **$0** pra você |
| Real-time STT | provider API do usuário | **$0** |
| TTS output | provider API do usuário | **$0** |
| Turn detection | local (VAD) | **$0** |
| STT / TTS provider choice | config | **$0** |
| Voice interrupt | local + WS | **$0** |
| Dictation puro | STT provider | **$0** |
| Voice compact mode / panel | client-side | **$0** |
| Audio debug | local | **$0** |

> Se você algum dia hospedar STT/TTS próprio, muda tudo: $0.003–0.006/min.

## 9. Automação / Scheduling

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Scheduled routines | daemon local executa no horário | **$0** (hoje roda no daemon do user) |
| Create / list / pause / resume / delete | Postgres | **~$0** |
| Schedule logs | Postgres (~1–10 KB por execução) | **~$0.02 / usuário-mês** |
| Loops (`/loop`) | daemon local | **$0** |
| Autonomous execution | daemon local | **$0** |

> **Gotcha:** se adicionar "remote scheduled agents" (executar server-side sem depender do daemon estar ligado), o custo sobe pra ~$0.005 / min-VM.

## 10. Org / Team

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Organizations | Postgres | **~$0** |
| Members & roles | Postgres | **~$0** |
| Invites | Postgres + e-mail (Resend) | **~$0.0005 / invite** |
| Team project sharing | Postgres | **$0** |
| Workspace sharing | Postgres + Colyseus | **$0** |
| Org switcher | client | **$0** |

## 11. Auth & Identity

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Google SSO | OAuth grátis | **$0** |
| GitHub SSO | OAuth grátis | **$0** |
| Email/password | Postgres + Resend (verificação) | **~$0.0005 / signup** |
| PKCE flow | Postgres | **$0** |
| Session tokens (JWT) | Postgres sessions | **~$0** |
| Daemon auth (bearer) | local | **$0** |

## 12. Billing / Plans

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Stripe checkout | Stripe fee | **2.9% + US$ 0.30 por cobrança** |
| Customer portal | Stripe (grátis) | **$0** |
| Plan tiers / feature gates | Postgres | **$0** |
| Webhook sync | auth-server | **~$0** |
| Admin plan management | Postgres | **$0** |

## 13. Integrações

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Open in editor (VS Code / JetBrains) | local | **$0** |
| Git ops (status/commit/merge/stash/push/pull) | local + relay se remoto | **incluso em relay** |
| PR GitHub (create / status) | GitHub API (do user) | **$0** |
| Task integrations (Issues/Linear) | APIs do provider (BYOK) | **$0** |
| Browser pane embutido | client | **$0** |
| Playwright browser | daemon local | **$0** |
| File explorer | local + WS | **incluso em relay** |
| Monaco editor | client | **$0** |
| File search | daemon local | **incluso em relay** |

## 14. Desktop-específico

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Daemon auto-start | local | **$0** |
| Dock badge | OS API | **$0** |
| Menu bar | OS API | **$0** |
| App updates | **CDN de releases** (ex: Cloudflare R2 ~$0.015/GB) | **~$0.01–0.05 / usuário-mês** em release cadence ativa |
| Titlebar drag | client | **$0** |
| System notifications | OS API | **$0** |
| Deep links `hubcode://` | OS | **$0** |
| Secure auth store | OS keychain | **$0** |

## 15. CLI

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Todos comandos (run / ls / logs / attach / send / wait / stop / delete / inspect / update / mode) | daemon local | **$0** |
| `daemon status` | local | **$0** |
| `schedule *` | local + Postgres quando persistido | **~$0** |
| `loop *` | local | **$0** |
| `chat` | auth-server WS | **~$0** |
| `library *` | auth-server + local sync | **~$0** |
| `--host` remoto | relay bandwidth | **incluso em relay** |
| `--worktree` | disk local | **$0** |

## 16. Power user / Misc

| Feature | Recurso consumido | Custo estimado |
|---|---|---|
| Artifacts drawer | local (blob) ou S3 se sync pra cloud | **~$0** (local) / **~$0.01 / usuário-mês** (cloud) |
| Tool calls sheet | WS + local | **$0** |
| Keyboard shortcuts | client config | **$0** |
| Command center | client | **$0** |
| **Push notifications** (mobile) | **APNS/FCM grátis** + token storage | **~$0** |
| Terminal pane + sessões persistentes | daemon local + relay se remoto | **incluso em relay** |
| Terminal input/output streaming | relay bandwidth | **incluso em relay** (mais verboso que chat: ~50 KB/min ativa) |
| Split panes | client | **$0** |
| Mode switching | WS | **$0** |
| Provider diagnostics | API ping (BYOK) | **$0** |
| Dark/light theme | client | **$0** |
| Kanban por workspace | Postgres | **~$0** |
| CLI agent detection | local subprocess | **$0** |

---

## Resumo dos vetores de custo por usuário ativo

| Vetor | Free user típico | Pro heavy user | Observação |
|---|---|---|---|
| **LiveKit self-hosted** (pair programming) | $0 (não usa) a $0.10 | $0.50–2 / mês | egress real + SFU fixo amortizado |
| **Relay bandwidth** | $0.10–0.50 | $1–3 / mês | maior custo variável |
| **S3 anexos** | $0.02–0.10 | $0.20–1.00 | heavy com muita mídia |
| **Postgres** (metadata/chat/logs) | $0.05–0.15 | $0.20–0.50 | linear com atividade |
| **SFU VPS fixo** (LiveKit) | $0.01–0.05 | $0.01–0.05 | ~$40/mês ÷ MAU |
| **Desktop auto-update CDN** | $0.01–0.05 | $0.02–0.10 | depende da cadence |
| **Infra fixa amortizada** | $0.10–0.30 | $0.10–0.30 | monitoring / auth-server / CI |
| **Total approximado** | **$0.30–1.20 / mês** | **$2–7 / mês** | antes de Stripe fee |

## Onde focar o metering

1. **LiveKit minutes** — cap duro no free (ex: 30 min/mês), métrica principal pro Pro.
2. **Relay bandwidth** — soft cap no free (5–10 GB), ilimitado fair-use no Pro.
3. **S3 storage** — quota de anexos (ex: 500 MB no free, 10 GB no Pro).
4. **Retenção de chat/activity** — 30 dias free, ilimitado Pro (economiza Postgres a longo prazo).
5. **Scheduled routines server-side** (se vier existir) — cap por min de execução.

## Onde NÃO metere

- Número de agentes locais, workspaces, indexing, skills/MCP locais, CLI, BYOK LLMs — tudo custo-zero pra você.
