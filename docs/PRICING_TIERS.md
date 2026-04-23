# Hubcode — Pricing Tiers × Features

Matriz feature × tier. Construída em cima de `FEATURE_COSTS.md` — tudo com custo marginal ~$0 pra você fica liberado desde o Free, e os gates ficam nos vetores realmente caros (LiveKit, relay bandwidth, S3, retenção, rotinas server-side, features de org).

## Tiers propostos

| Tier | Preço alvo | Quem | Proposta |
|---|---|---|---|
| **Free** | $0 | hobbyist, explorador | Experimentar tudo que é local; provar o valor do remote access com caps |
| **Dev** | **~$7 / mês** | dev solo usando seriamente | Remote access sem limite prático; bastante pair programming |
| **Pro** | **~$15 / mês** | power user, freelancer, indie | Automação server-side, rotinas, históricos longos, prioridade |
| **Team** | **~$25 / seat / mês** | times de 3–50 | Tudo do Pro + org, admin, audit, SSO light |
| **Enterprise** | custom (~$50+ / seat) | 50+ seats ou compliance | Self-hosted, SAML/SCIM, SLA, dedicated support |

**Convenção da tabela:**
- ✅ = incluído sem limite
- ❌ = não disponível
- **limite numérico** quando faz sentido (GB, min, #)
- 🟡 = incluído com restrição (anotada em nota)

---

## 1. Ciclo de vida do agente

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Run / Resume / Refresh agent | ✅ | ✅ | ✅ | ✅ | ✅ |
| Archive / Delete agent | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-provider (Claude / Codex / OpenCode) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Provider snapshot (models/modes/features) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Agent modes / model / thinking / feature toggles | ✅ | ✅ | ✅ | ✅ | ✅ |
| Message streaming | ✅ | ✅ | ✅ | ✅ | ✅ |
| Permission requests + dialog | ✅ | ✅ | ✅ | ✅ | ✅ |
| Abort / cancel | ✅ | ✅ | ✅ | ✅ | ✅ |
| Wait-for-finish | ✅ | ✅ | ✅ | ✅ | ✅ |
| Activity log retenção | **7 dias** | 30 dias | ilimitado | ilimitado | ilimitado |
| Agent timeline retenção | **7 dias** | 30 dias | ilimitado | ilimitado | ilimitado |
| Agentes concorrentes por usuário | ilimitado (local) | ilimitado | ilimitado | ilimitado | ilimitado |

> *Não faz sentido limitar # de agentes — rodam no daemon do user, custo zero.*

## 2. Acesso remoto

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Relay E2E | ✅ | ✅ | ✅ | ✅ | ✅ (self-host opcional) |
| **Relay bandwidth / mês** | **5 GB** | **50 GB** | 200 GB fair-use | 500 GB fair-use / seat | ilimitado |
| Connection codes / QR pairing | ✅ | ✅ | ✅ | ✅ | ✅ |
| Device pairing (# devices simultâneos) | **3** | 10 | ilimitado | ilimitado | ilimitado |
| Multi-client simultâneo (desktop+mobile+web+CLI) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Host switching (múltiplos daemons) | **2 hosts** | 5 | ilimitado | ilimitado | ilimitado |
| Daemon health checks | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Prioridade de fila no relay** | padrão | padrão | 🟡 alta | alta | dedicada |

## 3. Chat / Comunicação

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Org channels | ❌ | ❌ | ❌ | ✅ | ✅ |
| Direct messages (dentro de org) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Threads / reactions / mentions | — | — | — | ✅ | ✅ |
| Markdown rendering | ✅ | ✅ | ✅ | ✅ | ✅ |
| Anexos (imagem/vídeo/arquivo) — **quota S3** | — | — | — | **10 GB / org** | 100 GB / org |
| Typing indicators (Colyseus) | — | — | — | ✅ | ✅ |
| Org presence | — | — | — | ✅ | ✅ |
| Retenção de histórico | — | — | — | **90 dias** | ilimitado |
| Edit / delete / pin | — | — | — | ✅ | ✅ |
| Voice notes | — | — | — | ✅ | ✅ |
| Quoted messages / image lightbox | — | — | — | ✅ | ✅ |

> *Chat é feature de time por natureza — não faz sentido no Free/Dev/Pro individual.*

## 4. Shared sessions / Pair programming (LiveKit self-hosted)

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Invite flow + share links | ✅ | ✅ | ✅ | ✅ | ✅ |
| Access levels (read-only / full-access) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **LiveKit minutes-participant / mês** | **2 h (soft cap anti-abuso)** | **20 h** | **100 h** | **ilimitado (fair-use)** | ilimitado |
| Máx. participantes por sala | **3** | 5 | 10 | 20 | 50 |
| Session chat dedicado | ✅ | ✅ | ✅ | ✅ | ✅ |
| FIFO queue de mensagens | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cursors / selection rects / drawing | ✅ | ✅ | ✅ | ✅ | ✅ |
| Owner controls (ejetar / revogar) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Gravação de sessão** (egress p/ S3) | ❌ | 🟡 **2 h / mês** | **10 h / mês** | **40 h / seat** | ilimitado |
| Transcrição automática | ❌ | ❌ | 🟡 BYOK | ✅ | ✅ |

> *Self-hosted deixa o custo variável em egress (≈ $0.03–0.06 / hora-participante). Caps servem só pra segurar abuso (bot streaming 24/7) — é seguro ser muito mais generoso que LiveKit Cloud.*

## 5. Workspaces / Projects

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Project detection local | ✅ | ✅ | ✅ | ✅ | ✅ |
| Git remote tagging | ✅ | ✅ | ✅ | ✅ | ✅ |
| Worktrees (hubcode-worktree) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Workspace list / switch | ✅ | ✅ | ✅ | ✅ | ✅ |
| Team projects | ❌ | ❌ | ❌ | ✅ | ✅ |
| Workspace sharing com membros | 🟡 **1 convidado** | 3 convidados | 5 | ilimitado (org) | ilimitado |
| Project metadata (icon, tags) | ✅ | ✅ | ✅ | ✅ | ✅ |

## 6. Code indexing

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| CRG subprocess | ✅ | ✅ | ✅ | ✅ | ✅ |
| MCP tools crg | ✅ | ✅ | ✅ | ✅ | ✅ |
| Embedding hubcode-local | ✅ | ✅ | ✅ | ✅ | ✅ |
| Embedding openai-compat / sentence-transformers (BYOK) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-workspace opt-in | ✅ | ✅ | ✅ | ✅ | ✅ |
| FS watchers + auto-reindex | ✅ | ✅ | ✅ | ✅ | ✅ |
| Install flow (pipx/brew→pipx/python3-bootstrap) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Progress bar + indexBytes + process-state push | ✅ | ✅ | ✅ | ✅ | ✅ |

> *Indexing é 100% local. Liberado em todos os tiers — é ótimo pra conversão (usuário vicia no free).*

## 7. Library (Skills & MCP Marketplace)

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Browse skills + MCP servers | ✅ | ✅ | ✅ | ✅ | ✅ |
| Catálogo externo (PulseMCP / Smithery / skills.sh) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Install / Sync pra CLI local | ✅ | ✅ | ✅ | ✅ | ✅ |
| Scope: user | ✅ | ✅ | ✅ | ✅ | ✅ |
| Scope: workspace | ✅ | ✅ | ✅ | ✅ | ✅ |
| Scope: org | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Publicar skill/MCP no marketplace público** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Marketplace privado da org** | ❌ | ❌ | ❌ | ✅ | ✅ |
| Transport-aware (stdio / HTTP / SSE) | ✅ | ✅ | ✅ | ✅ | ✅ |

## 8. Voice / Dictation

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Voice mode full-duplex (BYOK) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Real-time STT (BYOK) | ✅ | ✅ | ✅ | ✅ | ✅ |
| TTS output (BYOK) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Turn detection / VAD | ✅ | ✅ | ✅ | ✅ | ✅ |
| STT/TTS provider choice | ✅ | ✅ | ✅ | ✅ | ✅ |
| Voice interrupt | ✅ | ✅ | ✅ | ✅ | ✅ |
| Dictation puro | ✅ | ✅ | ✅ | ✅ | ✅ |
| Voice compact mode / painel | ✅ | ✅ | ✅ | ✅ | ✅ |
| Audio debug | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Hubcode-hosted STT/TTS** (futuro, sem BYOK) | ❌ | 🟡 **60 min / mês** | 300 min | 1000 min / seat | ilimitado |

## 9. Automação / Scheduling

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Scheduled routines (daemon local) | ❌ | **2 rotinas** | **10 rotinas** | 20 / seat | ilimitado |
| Create / list / pause / resume / delete | — | ✅ | ✅ | ✅ | ✅ |
| Schedule logs retention | — | 30 dias | 90 dias | ilimitado | ilimitado |
| Loops (`/loop`) | 🟡 **max 10 iter** | 50 iter | ilimitado | ilimitado | ilimitado |
| Autonomous execution | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Remote-hosted scheduled agents** (daemon desligado) | ❌ | ❌ | 🟡 **60 min / mês** | 500 min / seat | ilimitado |

> *Se você ainda não oferece scheduled agents server-side, deixe como "Pro: coming soon".*

## 10. Org / Team

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Organizations | ❌ | ❌ | 🟡 **1 org pessoal, max 1 membro** | ✅ | ✅ |
| Members por org | 1 | 1 | 1 | **até 50** | ilimitado |
| Roles (owner / admin / member) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Invites por email / link | ❌ | ❌ | ❌ | ✅ | ✅ |
| Org switcher no app | ❌ | ❌ | ❌ | ✅ | ✅ |
| Workspace sharing com membros | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Audit log** (quem acessou o quê) | ❌ | ❌ | ❌ | 🟡 **90 dias** | ilimitado |
| **Billing centralizado** | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Admin: controle de skills/MCP permitidos** | ❌ | ❌ | ❌ | ✅ | ✅ |

## 11. Auth & Identity

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Google SSO | ✅ | ✅ | ✅ | ✅ | ✅ |
| GitHub SSO | ✅ | ✅ | ✅ | ✅ | ✅ |
| Email + password | ✅ | ✅ | ✅ | ✅ | ✅ |
| PKCE flow | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session tokens (JWT) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Daemon auth (bearer) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **2FA obrigatório opcional** | ❌ | ❌ | ❌ | ✅ | ✅ |
| **SSO SAML/OIDC empresarial** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **SCIM provisioning** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Políticas de senha / sessão** | ❌ | ❌ | ❌ | 🟡 básico | avançado |

## 12. Billing / Plans

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Stripe checkout | — | ✅ | ✅ | ✅ | ✅ (ou NET-30) |
| Customer portal | — | ✅ | ✅ | ✅ | ✅ |
| Plan tiers com feature gates | ✅ | ✅ | ✅ | ✅ | ✅ |
| Webhook sync | — | ✅ | ✅ | ✅ | ✅ |
| **Cobrança anual com desconto** | — | 🟡 15% off | 20% off | 20% off | negociado |
| **Volume discount** | — | ❌ | ❌ | 🟡 10+ seats | negociado |
| **Purchase orders / NET-30** | ❌ | ❌ | ❌ | ❌ | ✅ |
| Admin dashboard de plans | — | — | — | ✅ | ✅ |

## 13. Integrações

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Open in editor (VS Code / JetBrains family) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Git ops (status/commit/merge/merge-from-base/stash/push/pull) | ✅ | ✅ | ✅ | ✅ | ✅ |
| PR GitHub (create / status) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Task integrations (Issues, Linear) | 🟡 read-only | ✅ | ✅ | ✅ | ✅ |
| Browser pane embutido | ✅ | ✅ | ✅ | ✅ | ✅ |
| Playwright browser automation | 🟡 **20 execuções/dia** | ✅ | ✅ | ✅ | ✅ |
| File explorer + Monaco editor | ✅ | ✅ | ✅ | ✅ | ✅ |
| File search | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Slack / Discord integration** (futuro) | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Webhooks customizados** (futuro) | ❌ | ❌ | ❌ | 🟡 **10 webhooks** | ilimitado |

## 14. Desktop-específico

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Daemon auto-start | ✅ | ✅ | ✅ | ✅ | ✅ |
| Dock badge / menu bar / system notifications | ✅ | ✅ | ✅ | ✅ | ✅ |
| App updates automáticos | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Beta channel** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Canary / nightly builds** | ❌ | ❌ | ✅ | ✅ | ✅ |
| Titlebar drag / deep links | ✅ | ✅ | ✅ | ✅ | ✅ |
| Secure auth store (keychain) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Gerenciamento MDM-friendly** | ❌ | ❌ | ❌ | ❌ | ✅ |

## 15. CLI

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| `run` / `ls` / `logs` / `attach` / `send` / `wait` / `stop` / `delete` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `inspect` / `update` / `mode` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `daemon status` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `schedule *` | 🟡 list-only | ✅ | ✅ | ✅ | ✅ |
| `loop *` | 🟡 **max 10 iter** | ✅ | ✅ | ✅ | ✅ |
| `chat` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `library *` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `--host` (daemon remoto) — count into relay bandwidth | ✅ | ✅ | ✅ | ✅ | ✅ |
| `--worktree` | ✅ | ✅ | ✅ | ✅ | ✅ |

## 16. Power user / Misc

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Artifacts drawer (local) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Artifacts sync pra cloud** (S3) | ❌ | 🟡 **100 MB** | 1 GB | 10 GB / seat | ilimitado |
| Tool calls sheet | ✅ | ✅ | ✅ | ✅ | ✅ |
| Keyboard shortcuts customizáveis | ✅ | ✅ | ✅ | ✅ | ✅ |
| Command center | ✅ | ✅ | ✅ | ✅ | ✅ |
| Push notifications | ✅ | ✅ | ✅ | ✅ | ✅ |
| Terminal pane + sessões persistentes | ✅ | ✅ | ✅ | ✅ | ✅ |
| Split panes | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mode switching mid-conversation | ✅ | ✅ | ✅ | ✅ | ✅ |
| Provider diagnostics | ✅ | ✅ | ✅ | ✅ | ✅ |
| Dark/light theme | ✅ | ✅ | ✅ | ✅ | ✅ |
| Kanban por workspace | ✅ | ✅ | ✅ | ✅ | ✅ |
| CLI agent detection | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## 17. Operações / Suporte

| Feature | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| Community Discord / fórum | ✅ | ✅ | ✅ | ✅ | ✅ |
| Email support | ❌ | **48h SLA** | **24h SLA** | 8h SLA | **4h SLA** |
| Dedicated CSM | ❌ | ❌ | ❌ | ❌ | ✅ |
| Slack shared channel | ❌ | ❌ | ❌ | 🟡 add-on | ✅ |
| SLA uptime | best effort | best effort | 99.5% | 99.9% | **99.99%** |
| **Self-host relay** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Self-host LiveKit** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Self-host auth-server** (on-prem) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Security review / DPA | ❌ | ❌ | ❌ | 🟡 padrão | customizado |
| **SOC 2 report** | ❌ | ❌ | ❌ | ❌ | ✅ (quando aplicável) |

---

## Resumo visual compacto

| Eixo | Free | Dev | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| **Preço / mês** | $0 | ~$7 | ~$15 | ~$25 / seat | custom |
| **Seats** | 1 | 1 | 1 | 3–50 | 50+ |
| **Relay bandwidth** | 5 GB | 50 GB | 200 GB | 500 GB / seat | ilimitado |
| **LiveKit minutes** (self-host) | 2 h | 20 h | 100 h | fair-use | ilimitado |
| **Rotinas agendadas** | ❌ | 2 | 10 | 20 / seat | ilimitado |
| **Retenção (activity/chat)** | 7 d | 30 d | ilimitada | ilimitada | ilimitada |
| **Org features (chat/roles/admin)** | ❌ | ❌ | ❌ | ✅ | ✅ |
| **SSO SAML / SCIM** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Self-host** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Suporte** | community | email 48h | email 24h | email 8h + CSM lite | 4h + dedicated CSM |

---

## Notas de posicionamento

- **Free precisa ser útil sozinho.** Um dev instalando hoje tem que conseguir: rodar agentes locais sem limite, usar indexing, conectar remotamente pelo celular (dentro dos 5 GB) e testar pair programming (30 min/mês bastam pra "uau, funciona"). Se o free for pobre demais, ninguém vira usuário pro.
- **Dev vs Pro** — a diferença principal é **automação server-side** (rotinas, loops pesados, scheduled remote agents). Dev é "remote access sério", Pro é "trabalho assíncrono".
- **Team é quando o Colyseus + chat + org valem a pena cobrar.** Antes disso, tudo que é "social" fica fora.
- **Enterprise só compensa com self-host + SSO + SOC2** — pouco volume, muito esforço. Mire nos 1–2 deals de $50k+ ARR antes de investir em certificações.
- **LiveKit self-hosted muda a conversa.** Com SFU próprio, o custo real é egress (~$0.03–0.06/hora-participante) + uma VPS fixa. Isso libera ser **muito generoso** no pair programming — não é preciso cap agressivo pra proteger margem, só anti-abuso. Aproveite pra fazer disso um diferencial forte vs. concorrentes que pagam LiveKit Cloud.
- **Metering-first:** implemente medição de bandwidth/minutos/rotinas antes dos caps duros. Melhor começar com soft-cap e email "você passou do limite" do que cortar abruptamente e queimar confiança.
