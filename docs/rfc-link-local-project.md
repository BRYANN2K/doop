# RFC: Link a local project + a chat tab that plans before it designs

Status: draft for review — no code yet.
Scope: doop fork `bryann2k/main`, desktop app (Tauri) + server (VPS) + web.

## What this adds

1. **Link a canvas to a local folder.** In a canvas, a desktop-app user picks a
   folder (a Git repo) on their machine. The canvas remembers the link, per
   user.
2. **The doop agent reads that folder, read-only.** New agent tools
   (`repo_list`, `repo_read`, `repo_search`) let the resident agent — and the
   Claude Plan desktop runner — design in the project's own language: tokens,
   components, copy, README/AGENTS.md. The agent never writes, never runs
   anything, and never sees secrets.
3. **A Chat tab.** A new tab in the canvas's right panel where people talk
   with the doop agent about the canvas and the linked project.
4. **Plan, then confirm, then design.** When a chat ask implies design work,
   the agent's first answer is a _plan card_ — screens, sections, components
   it will reuse from the repo, open questions. Design starts only when a
   human presses **Go design**, which they can edit or decline first.

## Why the round-trip is the way it is

The server runs on the VPS; the repo lives on the Mac. The server cannot read
the Mac's disk, and must never hold the folder's absolute path. So:

- The **folder grant** (path → link id) stays in the desktop app's data
  directory, exactly like `claude.rs` keeps CLI picks and `fonts.rs` keeps
  picked font paths — the page learns a link id and a display name, never the
  path.
- The **server** stores only the link's existence (`repo_links` row) so the
  agent knows a project is attached and collaborators see the badge.
- **Reads flow through the page that already bridges the app and the server**:
  a poll channel mirroring `/api/local-agent/poll`. The server hands a read
  request to the desktop webview; the webview calls a native Tauri command;
  the native side sandboxes the path and returns bounded bytes. File contents
  pass through memory only — nothing repo-side is persisted server-side.

This works for _both_ agent runtimes: tool calls of a server-side resident run
execute server-side (`execTool` in `server/resident.ts`), and tool calls of a
Claude Plan run funnel back through `/local-agent/mcp/:id` into the same
`execTool`. One server-side "repo service" serves both.

Availability rule, matching the brief: **reads only work while the app is
open** — the poll channel lapses when the desktop app (or its signed-in page)
goes away, and pending requests expire.

## User journey

1. In a canvas on the desktop app, the Chat tab (or a "Local project" row in
   the Agents panel) offers **Link a local folder…**. A native folder picker
   opens (rfd `pick_folder`), then a native consent dialog explains the
   read-only scope, like the Claude Plan consent. Cancel leaves nothing
   behind.
2. On accept, the shell registers `linkId → absolute path` locally and the
   page `POST`s `{ linkId, name }` to the server. The canvas shows a "Local
   project: <folder name>" chip in the Chat tab, with **Unlink**.
3. Bryan types in Chat: "a settings screen for the billing page". The send
   queues a **plan run** — the agent reads the canvas, lists/searches the
   linked repo, and replies in the chat with a **plan card**: intent, the
   screens/frames it will create (sizes), the repo pieces it will reuse
   (token file, `Button.tsx`, locale strings), and open questions.
4. Bryan either **Go design**, **Edit plan** (the plan text becomes an editable
   draft before launching), **Revise** (replies in the thread — a new plan run
   with the conversation as context supersedes the card), or **Cancel**.
5. **Go design** materializes the plan into ordinary board card(s) carrying
   the approved plan text. The existing resident pipeline — or Claude Plan —
   picks them up and designs, streaming as usual; the chat reports progress
   and links the cards.
6. Non-design asks ("which component does the checkout button use?") get a
   plain conversational answer — no plan card. The agent decides; the system
   prompt makes design-implying asks always go through a plan first.

## Architecture

```
Mac (desktop app)                          VPS (doop server)
┌───────────────────────────┐              ┌────────────────────────────┐
│ webview (the doop page)   │              │ resident agent / chat run  │
│  src/lib/localRepo.ts     │◄──HTTPS──────│  execTool → repo service   │
│   poll /api/local-repo/*  │  session     │  server/localRepo.ts       │
│   invoke('repo_*')        │              │  repo_links table          │
│        │                  │              └─────────────┬──────────────┘
│        ▼ Tauri IPC        │                            │ run.request.tools
│  repo.rs (Rust)           │              ┌─────────────▼──────────────┐
│   grants in app data dir  │              │ /local-agent/mcp/:id relay │
│   path sandbox + limits   │              │ (Claude Plan runs as-is)   │
└───────────────────────────┘              └────────────────────────────┘
```

### New native module — `desktop/src-tauri/src/repo.rs`

Modeled on `fonts.rs` and `claude.rs`:

- `repo_choose(canvas_id)` → native `pick_folder` + consent dialog → returns
  `{ linkId, name }` (random id, folder basename). Stores the grant in
  `repo-grants.json` in the app data dir, written atomically (same pattern as
  `write_chosen`).
- `repo_forget(link_id)` → drops the grant.
- `repo_grants()` → the link ids this device can serve, so the page claims
  only requests it can answer.
- `repo_list(link_id, subdir?, depth?)` → bounded tree (cap ~2000 entries,
  skips `.git`, `node_modules`, vendor-ish noise, `.gitignore`-aware best
  effort).
- `repo_read(link_id, paths[])` → text of up to N files under a byte cap
  (per file ~128 KB, per call ~200 KB). UTF-8 text only; binary refused.
- `repo_search(link_id, query, glob?, limit?)` → literal/regex substring
  search, capped matches with file + line + excerpt.

Sandbox guarantees, enforced in Rust, not in the page:

- Resolve the canonical grant root once; every requested path is joined,
  normalized and **canonicalized, and must stay inside the canonical root** —
  that rejects `..` and symlinks pointing outside.
- Denylist, applied to the _relative_ path: directories `.git`, `.svn`, `.hg`,
  `node_modules`; files matching `.env*` , `*.pem`, `*.key`, `*.p12`,
  `*.keystore`, `*.asc`, `id_rsa*`, `*.kdbx`, `*credential*`, `*secret*`,
  `.netrc`, `.npmrc`, `.pypirc`, `*.tfvars` (name match, case-insensitive).
- Size limits as above; directories and non-regular files are skipped.
- New commands are registered in `main.rs`'s `invoke_handler`, granted in
  `capabilities/default.json` (`allow-repo-*`), and gated by a new marker
  `__DOOP_LOCAL_REPO__` so older shells show an update hint instead of an
  unknown-command error.

### Server side

**New table `repo_links`** (drizzle migration, next number after 0052):

| column                       | notes                                                      |
| ---------------------------- | ---------------------------------------------------------- |
| `id`                         | the `linkId` minted by the client at pick time             |
| `canvas_id`                  | the canvas the folder is linked to                         |
| `user_id`                    | the link is per user — the agent uses the requester's      |
| `name`                       | folder basename only — the path never leaves the Mac       |
| `device_id`                  | the install that holds the grant; a different poller warns |
| `created_at`, `last_used_at` | housekeeping                                               |

One row per `(canvas_id, user_id)` — re-linking replaces it.

**New routes** (mounted like `localAgentRouter`, all session-guarded and
re-checking `canEditCanvas` / view for reads):

- `GET /api/canvases/:id/repo` → the caller's link for this canvas, plus
  `online` (a device of theirs is polling), like `GET /api/local-agent`.
- `POST /api/canvases/:id/repo` `{ linkId, name }` → create/replace the link.
- `DELETE /api/canvases/:id/repo` → unlink (revocation).
- `POST /api/local-repo/poll` `{ deviceId, grants: [linkId…] }` → long-poll
  (~20 s) for the caller's pending repo requests targeting a grant they hold.
  Same ownership rules as `/api/local-agent/poll` (one active device; banned
  and impersonated sessions refused).
- `POST /api/local-repo/finish/:requestId` `{ deviceId, result }` → resolves
  the pending request.

**`server/localRepo.ts`** — the dispatcher: `repoRequest(userId, linkId, op,
args) → Promise<result>`. Holds pending requests in memory with a ~60 s TTL,
wakes the poll waiter, resolves on finish. Read results never hit the DB.
`localRepoOnline(userId)` reports whether a device is polling, for the link
status and for tool gating.

### The agent's repo tools

Appended to `TOOLS` in `server/resident.ts` only when the run's _payer_ (the
requesting user — `queuedByUserId` / `fromUserId`, already resolved per run)
has a link on this canvas:

- `repo_list` — "List the linked local project's tree (bounded). Start here to
  see how the repo is organized before reading files."
- `repo_read` — "Read files from the linked local project by repo-relative
  path (batch several). For design tokens, components, styles, copy."
- `repo_search` — "Search file contents in the linked local project (literal
  or regex). Returns matching lines with path and context, capped."

`execTool` gains handlers that resolve the payer's link and call
`localRepo.repoRequest`. An offline/unlinked failure is a normal tool error:
"The linked project is unavailable — the doop desktop app holding it isn't
online." The tools ride to Claude Plan runs unchanged: they appear in
`run.request.tools`, and `/local-agent/mcp/:id` already routes calls back to
`execTool`. The system prompt gains a short section: a linked project means
_investigate before designing_ — read tokens/components/copy and reuse them,
as the GitHub recon prompt already teaches (`server/githubRecon.ts` is the
precedent for tree-excerpting and byte budgets).

### Chat

- **New table `chat_messages`**: `id`, `canvas_id`, `from_name`, `from_kind`
  (`user`/`agent`), `from_user_id`, `text`, `mentions`, `thread_id` (replies),
  `plan` (jsonb: structured plan + status `proposed`/`approved`/`revised`/
  `launched`/`canceled`), `task_ids` (cards it spawned), `created_at`.
  This deliberately revives the shape of migration `0018_chat.sql`, dropped
  in `0030` — with the plan payload added.
- **Transport**: send via REST `POST /api/canvases/:id/chat` (session +
  edit role), broadcast over the existing canvas WS room as
  `chat:message` (extends `ServerMessage`), `init` carries recent history —
  same pattern as comments/feedback.
- **UI**: new `'chat'` `PanelTab`, a `ChatPanel.tsx` next to
  `CommentsPanel.tsx` — message list, composer, the plan card component, a
  "Local project" chip row (link/unlink status). The rail button gets the
  same dot treatment as the other tabs.
- **Addressing**: messages are to the doop agent by default; plain
  conversation between humans is allowed but an `@doop`-style send is what
  triggers a run (keeps accidental spend down).

### Plan mode

- A chat send that @mentions the agent queues work for a dedicated **chat
  run** in `resident.ts` — a sibling of the card sweep, keyed per
  `(canvas, requester, runner)` like `workKey`.
- The chat run gets a _plan-only_ toolset: read tools (canvas listing,
  `inspect_frame`, `screenshot_frame`, bounded `get_frame_html`), the
  `repo_*` tools, `propose_plan` and `ask_in_chat`. **No write tools** — a
  chat run structurally cannot touch a frame.
- `propose_plan({ summary, screens: [{name, width, height, outline,
reuse: [repo paths / component ids]}], openQuestions: [] })` writes the
  plan message into the thread and ends the run. `ask_in_chat` posts a plain
  question and ends the run waiting for the human.
- **Go design** is deterministic server code — `POST
/api/chat/:messageId/launch` validates the plan's status and the caller's
  edit role, then queues one board card per screen whose text embeds the
  approved plan (plus the requester's runner pick), marks the plan
  `launched`, and posts a chat reply naming the cards. The ordinary pipeline
  takes it from there; no agent involvement in the confirmation step.
- **Revise**: a reply on a plan thread queues another plan run with the
  recent thread (say, last 30 messages) as context; the new plan card
  supersedes the old one (`revised`).
- **Cancel** marks the plan `canceled`; the thread stays for context.

This also answers upstream issue #337's spirit: the agent's substantive
responses land in the chat surface people are already looking at.

## Security

- **Consent**: the only way in is a native folder picker plus a native
  consent dialog; the page cannot supply or guess a path (the `fonts.rs`
  contract: paths only ever come from the panel).
- **Sandbox**: canonical-root confinement in Rust — `..`, symlink escapes and
  absolute paths from the network side all fail; denylisted secret names and
  directories; bounded sizes; regular UTF-8 files only.
- **Path privacy**: the absolute path never leaves the Mac; the server and
  other collaborators see only the folder's basename.
- **While-open availability**: reads need a live poll from a desktop session
  of the linking user; requests expire (~60 s) unanswered rather than
  queueing up.
- **Attribution**: every `repo_*` call resolves the link of the _requesting_
  user — a collaborator's card can't read Bryan's repo; it reads their own
  linked project or none.
- **Revocation**: server-side unlink deletes the row (agent calls fail
  immediately); device-side "forget" drops the grant (claims stop). Either
  alone cuts access.
- **No execution, no writes**: the native commands implement list/read/search
  only; there is no write, delete, move, or exec surface to abuse.
- **Session rules**: poll/finish follow `/api/local-agent`'s model — banned
  users refused, read-only impersonation cannot poll, one claiming device per
  user at a time.
- **Audit**: tool calls are logged like today's `[resident] tool …` lines,
  with path names but not contents.

## Files this will touch

Server:

- `server/db/schema.ts`, `server/db/migrations/0053_local_repo.sql`,
  `0054_chat.sql` — `repo_links`, `chat_messages`.
- `server/localRepo.ts` (new), `server/localRepoRoutes.ts` or inside
  `index.ts` — link CRUD + poll/finish.
- `server/resident.ts` — repo tool defs + `execTool` handlers, chat/plan run,
  `propose_plan`/`ask_in_chat` handling, system-prompt section, tool gating
  by link.
- `server/index.ts` — mount routes; `chat:message` in the WS room broadcast.
- `server/chatCompletionsAgent.ts` / `agentModel.ts` — only if the chat run
  needs a different max-turns profile; probably reuse.
- `shared/types.ts` — `ChatMessage`, `ChatPlan`, `ServerMessage` variants.
- `shared/localRepo.ts` (new) — request/response types, caps, denylist spec
  mirrored with `repo.rs`.

Desktop (`desktop/src-tauri/`):

- `src/repo.rs` (new), `src/main.rs` (register commands, `__DOOP_LOCAL_REPO__`
  marker), `capabilities/default.json` (`allow-repo-*`).

Web:

- `src/lib/api.ts` — link CRUD, chat send/history, poll/finish, launch.
- `src/lib/localRepo.ts` (new) — poll loop, grant claims, native invoke
  (mirroring `localAgent.ts`).
- `src/components/ChatPanel.tsx` (new), `PlanCard` inside it, `SideRail.tsx`
  (`'chat'` tab), `src/lib/store.ts` (`PanelTab`), i18n strings.
- `src/App.tsx` / `CanvasPage.tsx` — start the repo poll for desktop
  sessions (next to `startLocalAgent`).

Docs/tests:

- `desktop/README.md` (Local project section), `README.md` (feature bullet),
  tests mirroring `fonts.rs`/`localAgentRuns` coverage (sandbox escapes,
  denylists, caps, poll ownership) plus server tests for link scoping.

## Estimate in steps

1. Schema + shared types: `repo_links`, `chat_messages`, shared wire types
   and caps. (small)
2. Rust `repo.rs`: grants store, picker + consent, sandboxed list/read/search,
   commands + capability. (medium — the security core, with unit tests)
3. Server `localRepo.ts` + routes: link CRUD, poll/finish dispatcher, online
   status. (small-medium)
4. Agent plumbing: `repo_*` tool defs + `execTool` handlers + gating + system
   prompt. (small)
5. Chat backend: message table, send/history, WS broadcast, chat run with
   plan-only tools, `propose_plan`, launch endpoint. (medium-large)
6. Chat UI: panel tab, message list, composer, plan card with Go/Edit/
   Revise/Cancel, link chip. (medium-large)
7. Wiring: poll loop start, markers, i18n, Settings/README docs, tests.
   (medium)

Suggested ship order: 1–4 first (repo tools usable from board cards, before
chat exists), then 5–7.

## Risks and open questions

- **Latency**: each `repo_*` call crosses server → desktop → server. Poll is
  ~long-poll so typical overhead is low, but a run that reads 20 files feels
  it. Mitigation: `repo_read` batches paths; `repo_list` returns a whole tree
  slice per call.
- **Two desktops, one user** — decided: the link stores the `deviceId` of the
  install that picked the folder, and the link status warns when the device
  currently polling is a different one (or holds no grant for it). Grants
  live per-device; the poll advertises grant ids so only a device holding
  the grant claims a request.
- **Chat vs comments/tasks overlap**: a third conversational surface next to
  comments and board cards can confuse. Proposal: chat answers questions and
  produces plans; durable work still lands as board cards; comments stay
  anchored feedback. Worth confirming before build.
- **Plan fidelity**: the plan card's `screens[]` becomes cards verbatim —
  editing a screen list mid-confirm is covered by "Edit plan" turning the
  whole plan into a draft, not per-row editing.
- **Who may press Go** — decided: any editor of the canvas. The launch
  queues the cards as the pressing editor, and the plan card shows who
  launched.
- **External MCP clients**: `repo_*` tools stay resident-only for now — a
  Claude Code on the same Mac can read the disk itself. Expose later if
  wanted.
- **.gitignore fidelity**: a full ignore implementation in Rust is heavy;
  start with the fixed denylist + `node_modules`/`.git` skips and revisit if
  repos prove noisy.
- **iOS app**: out of scope — no file grants there.
