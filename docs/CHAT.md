# Chat (Slack-style) — Implementation Plan

Chat interno por org: channels públicos/privados, DMs, threads, reactions, anexos, menções, markdown. Layout unificado web/desktop/mobile (Expo + RNW + Unistyles). Transporte realtime sobre Colyseus (`OrgChatRoom`), persistência em Postgres via auth-server.

**Princípios:**
- Sem dados fake em nenhuma fase — cada fase é end-to-end com dados reais.
- Cada fase = 1 PR, com testes verdes, typecheck, format.
- Testes de integração contra dependências reais (Postgres, Colyseus), nunca mocks.
- Backward-compatible por default (cliente antigo + daemon/server novo deve funcionar).

## Stack

| Função | Plugin |
|---|---|
| Lista virtualizada | `@shopify/flash-list` |
| Markdown render | `react-native-markdown-display` |
| Code highlight | `react-native-syntax-highlighter` |
| Emoji picker | `rn-emoji-keyboard` |
| Menções | `react-native-controlled-mentions` |
| Upload | `expo-document-picker` + `expo-image-picker` |
| Image viewer | `react-native-image-viewing` |
| Datas | `dayjs` + `relativeTime` |
| Rich text (opcional) | `@10play/tentap-editor` (avaliar depois) |

## Modelo de dados

```
channels
  id, org_id, name, kind ('public'|'private'|'dm'), topic,
  created_by, created_at, archived_at

channel_members
  channel_id, user_id, role ('admin'|'member'),
  joined_at, last_read_at, muted, notify_pref

messages
  id, channel_id, user_id, parent_id (null | root),
  content (markdown string), attachments (jsonb),
  created_at, edited_at, deleted_at

reactions  (PK: message_id, user_id, emoji)
mentions   (message_id, user_id)
pins       (channel_id, message_id, pinned_by, pinned_at)
```

- DM = `channels.kind='dm'`, 2 (ou N) membros em `channel_members`.
- Soft delete em mensagens (`deleted_at`) — renderer mostra placeholder.
- Markdown puro é a fonte de verdade — nunca HTML.

---

## Fase 0 — Fundação

Schema + migrations. Trigger criando `#general` ao criar uma org.

**Testes:**
- CRUD de channel, dedup de membros, ordenação estável de mensagens.
- Visibilidade: user vê public da org + privates em que é membro.

## Fase 1 — REST de channels & membership

- `POST /orgs/:orgId/channels` (public/private).
- `GET /orgs/:orgId/channels` — filtra por visibilidade.
- `POST/DELETE /channels/:id/members`.
- `POST /channels/:id/archive`.
- `GET /users/me/dms`, `POST /dms` (idempotente entre 2 users).

**Testes:**
- Auth válida/inválida/cross-org em cada endpoint.
- Cross-org = 403. DM idempotente.

## Fase 2 — Mensagens REST + histórico paginado

- `POST /channels/:id/messages` (valida membership).
- `GET /channels/:id/messages?before=<id>&limit=50`.
- `PATCH/DELETE /messages/:id` (só autor).

**Testes:**
- Paginação estável (200 msgs em páginas de 50, sem duplicata).
- Non-member não lê privates.

## Fase 3 — Realtime `OrgChatRoom` (Colyseus)

- Uma room por org. `onJoin` valida membership.
- `onMessage("send" | "typing" | "edit" | "delete" | "react")`.
- Broadcast filtrado por membership do channel.
- Histórico **não** vive no state — só REST.

**Testes:**
- 2 clients público: msg de A chega em B.
- 3 clients com private: non-member **não** recebe.
- Typing efêmero, não persiste.
- Remover member → para de receber.

## Fase 4 — UI shell (3 zonas, adaptativa)

Layout Slack: Sidebar (channels + DMs) | MessageList (FlashList inverted) | (ThreadPanel lateral no desktop).

Mobile: stack (Sidebar → ChannelList → Messages → Thread).

Consumo de dados **reais** das fases 1-3. Composer é TextInput simples nesta fase.

**Testes:**
- Component tests (React Native Testing Library) contra auth-server em modo test.
- Playwright smoke: login → channel → enviar → outro cliente vê.

## Fase 5 — Rich text (markdown)

- Composer: TextInput + toolbar (bold, italic, code, list) + atalhos no web (cmd+b/i/e).
- Render: `react-native-markdown-display` com tema Unistyles.
- Codeblock: `react-native-syntax-highlighter`.

**Testes:**
- Render de cada sintaxe.
- Atalhos inserem markers.
- Vazio-após-trim não envia.

## Fase 6 — Menções (@user, #channel)

- `react-native-controlled-mentions` com 2 triggers.
- Armazena `<@userId>` / `<#channelId>` dentro do markdown.
- Backend extrai menções → tabela `mentions` → badges.

**Testes:**
- Round-trip de parser (texto ↔ markdown ↔ render).
- Mention cross-org é ignorada.
- Badge incrementa só no destinatário.

## Fase 7 — Threads

- `parent_id` já existe desde fase 0.
- Desktop: drawer lateral (SplitContainer). Mobile: screen empilhada.
- `GET/POST /messages/:id/replies`.
- Thread count materializado via trigger.

**Testes:**
- Reply só aparece na thread.
- Thread count atualiza.
- Delete de parent preserva replies.

## Fase 8 — Reactions

- `rn-emoji-keyboard`. Long-press no mobile, hover no desktop.
- `POST/DELETE /messages/:id/reactions {emoji}`.
- Broadcast `reaction_added/removed` via Colyseus.

**Testes:**
- Reaction duplicada = no-op.
- Remover por outro user não afeta a do primeiro.
- Agregação "😀 ×3" + lista de quem reagiu.

## Fase 9 — Upload de arquivos

- Bucket R2/S3 + `POST /uploads/presign`.
- Cliente faz PUT direto. Message envia com `attachments: [...]`.
- Pickers: `expo-document-picker`, `expo-image-picker`.
- Render: thumbnail inline + fullscreen (`react-native-image-viewing`).

**Testes:**
- Presign rejeita mime fora da whitelist.
- Limite de tamanho respeitado.
- Delete de msg não apaga blob (GC assíncrono depois).

## Fase 10 — Unread + badges

- `POST /channels/:id/read {messageId}` ao scrollar até o fundo.
- `GET /channels` retorna `unreadCount` + `hasMention`.
- Realtime incrementa badge local; focar zera.

**Testes:**
- Read zera contador.
- Mention marca `hasMention` independente de foco.
- Contagem correta em channel com 1000 msgs.

## Fase 11 — Polimentos base

- Busca (Postgres `tsvector`).
- Pins de mensagem.
- Edit com "(edited)".
- Delete com placeholder "mensagem removida".
- Push notifications (reaproveitar infra Hubcode).

---

## Fase 12 — Paridade com Slack

Polimento que separa "chat funcional" de "chat Slack-like de verdade". Cada item = sub-PR.

### 12.1 — Header de channel com membros
Topo: nome + tópico + avatares empilhados (até 5-8) + "+N" + "Add people". Click abre modal completo. DM mostra avatar + presence. Private: ícone de cadeado.

### 12.2 — Thread com paridade total ao composer principal
Thread herda tudo: markdown, menções, upload, reactions, typing. Extrair `<MessageComposer>` reutilizável, parametrizado por `target: {channelId, parentId?}`. Checkbox "Also send to #channel" cria 2 mensagens.

### 12.3 — Presence (online/away/offline)
`OrgChatRoom` expõe presence por user. Dot verde/amarelo/cinza. Away após X min de inatividade (reportado pelo cliente). Múltiplas abas = online se pelo menos uma ativa.

### 12.4 — Menu de ações na mensagem
Hover/long-press: reagir, reply thread, forward, copy link, pin, edit (autor), delete (autor/admin). Mobile abre bottom sheet (`@gorhom/bottom-sheet`).

### 12.5 — Deep linking
`/org/:o/channel/:c?m=:messageId` scrolla + highlight 2s. Pagina histórico até achar. Link pra msg de thread abre o drawer/screen automaticamente.

### 12.6 — Replies preview na sidebar
Channel com atividade em thread: "3 replies · 2m ago". Seção "Threads" agregando threads em que o user participou.

### 12.7 — Notifications per-channel
`all` / `mentions` / `nothing`. Default: `mentions` em channels, `all` em DMs. Muted: cinza, sem badge numérico. Mention ainda gera badge.

### 12.8 — Create/invite flow
Modal "Create channel" (nome, descrição, kind, pré-membros). "Browse channels" lista públicos. Invite link token-based pra privates.

### 12.9 — Rich previews (unfurling)
URL em msg → backend busca `og:*` → card. Cache 7d. SSRF guards (bloqueia IPs privados). Limite de N cards por msg.

### 12.10 — Pins & saved items
`POST /channels/:id/pins/:messageId` (admin/autor). Painel lateral "Pinned". `POST /users/me/saved/:messageId` = saved pessoal.

### 12.11 — Markdown avançado
Blockquote, tabelas GFM, task list interativa (`- [ ]` toggle persiste se autor), spoiler `||texto||` custom.

### 12.12 — Slash commands
`/shrug`, `/me`, `/remind`, `/poll`. Sistema extensível com handlers no backend + autocomplete no composer. Futuro: `/agent start` pra integrar com Hubcode agents.

### Ordem sugerida dentro da fase 12
12.2 → 12.1 → 12.4 → 12.5 → 12.3 → 12.7 → 12.8 → 12.10 → 12.6 → 12.11 → 12.9 → 12.12.

---

## Milestones de release

- **Alpha interno** após Fase 4 (texto puro funciona end-to-end).
- **Beta público** após Fase 6 (markdown + menções).
- **GA** após Fase 9 (anexos, principal feature ainda faltante).
- **Slack parity** ao final da Fase 12.

## Estimativa

Fases 0-11: ~3-4 semanas full-time. Fase 12: ~2 semanas. Total: **4-6 semanas** para 1 pessoa com testes decentes.

## Pontos de atenção recorrentes

- **Authz por mensagem**: room é da org, mas cada `send` revalida membership do channel (senão user da org escreve em private que não é membro).
- **Ordering**: `created_at` + tiebreaker por `id` (ULID/snowflake) pra evitar empate em mesma ms.
- **Replay em reconexão**: cliente guarda `lastSeenMessageId` por channel, reconecta pede `messages WHERE id > lastSeenId`.
- **Schema evolution**: todo novo campo em mensagens/channels = `.optional()` com fallback, nunca required. Old client + new daemon deve parsear.
- **Storage GC**: uploads órfãos (msg deletada antes de enviar) e anexos de soft-deleted messages precisam de job de limpeza assíncrono.
