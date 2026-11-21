# LLMUI HTTP API

The API a native client (the iOS app) uses, as it exists today. Everything here is served by one Express process (`server/index.js`) that also serves the web app.

Examples are real responses captured from an isolated instance (scratch database, real machines, read-only calls) on 2026-11-20. Tokens are replaced with `<token>`. The stored-image example uses a synthetic image written through the same code path as a real generation.

Examples in §2.2–2.3, §4.1–4.3 and §8.3–8.4 were captured from an isolated instance whose model server and sd-server were local fakes speaking the same wire formats (no GPU was used). That's why the model id is `test/fake-model-GGUF:Q4_K_M` and the text is filler.

Labels used below:

- **Stable**: safe to build on; changes will be additive.
- **Unstable**: shape may change, or depends on an upstream format that hasn't been checked live.
- **Web-only**: exists for the React app; a native client shouldn't need it.

---

## Contents

1. [Conventions](#1-conventions)
2. [Auth and pairing](#2-auth-and-pairing)
3. [Chats](#3-chats)
4. [Sending a message (streaming)](#4-sending-a-message-streaming)
5. [Machines](#5-machines)
6. [Text models](#6-text-models-per-machine)
7. [Image models](#7-image-models-per-machine)
8. [Images](#8-images)
9. [GPU stats](#9-gpu-stats)
10. [Other endpoints](#10-other-endpoints)
11. [Known gaps](#11-known-gaps)

---

## 1. Conventions

**Base URL.** `https://box.tailde6c83.ts.net:8452` (`tailscale serve` → Express on `127.0.0.1:3001`). The phone must be on the tailnet.

**Bodies.** JSON in and out (`Content-Type: application/json`), 5 MB request limit. Exceptions: image bytes, and the event streams in §4 and §8 (NDJSON or SSE).

**Errors.** Every API error is JSON. Two shapes exist:

| Where | Shape |
|---|---|
| Everything under `/api` | `{"error": "message", "code": "optional_code", ...}` |
| `/openai/v1/*` (OpenAI passthrough) | `{"error": {"message": "...", "code": "...", "type": "..."}}` |

Requests that fail before any route runs (malformed JSON body, database constraint) also return JSON: `400 {"error": "Expected property name or '}' in JSON at position 1 (line 1 column 2)"}`, `500 {"error": "Internal server error"}`.

**Status codes.**

| Code | Meaning |
|---|---|
| 400 | Invalid input. `error` says what's wrong. |
| 401 | Missing, wrong, expired or revoked token: `{"error":"Unauthorized"}`. |
| 404 | Unknown id. |
| 409 | Conflict: GPU busy with an image job (`code: "image_generation_in_progress"` or `"gpu_busy"`), the pinned machine changed (`code: "machine_changed"`), a reply is already being generated in that chat (`code: "run_in_progress"`), or a job hasn't completed (`code: "job_running"` etc.). See §4, §5 and §8. |
| 429 | Rate limit: `{"error":"Too many requests, please try again later"}`. |
| 502 | An upstream (model server, sd-server, download helper, Hugging Face) failed or is unreachable. |
| 503 | A machine's download helper isn't configured on the server. |

**Rate limit.** 200 requests per minute per client IP across the whole API (the `RateLimit-*` headers report it). Poll gently: 2–5 s for status, 1 s for GPU stats at most while visible.

**Timestamps** are Unix milliseconds. **Ids** are nanoid strings (21 chars).

**Machines.** There are two compute machines, `jellyfin` (default) and `workstation`. Most requests go to the *selected* machine (§5). A few read-only and install/delete routes accept `?machine=<id>` to target a specific one. Any other route rejects `?machine=` with 400 rather than silently using the selected machine.

---

## 2. Auth and pairing

### 2.1 Sending the token — Stable

Every endpoint except `/health`, `/api/setup/status` and `POST /api/session` needs one of:

```
Authorization: Bearer <device token>
```

- **Device token** (what the iOS app uses): 64 hex characters, created by pairing (§2.2). Each paired device has its own, listed in Settings → Devices with its last use, and revocable there (§2.3). Store it in the iOS Keychain. A revoked or unknown token gets `401 {"error":"Unauthorized"}`; on 401 the app should show "Pair again".
- **Server token**: the contents of `~/.llmui/token` on the server. It's never served over HTTP; only local tools that can read the file (the TUI) use it.
- **Browser session**: the web app's cookie (§2.4). Native clients don't use it.

There are no scopes: every credential has full access. CORS: native requests send no `Origin` and are allowed. Request headers the server accepts cross-origin: `Authorization`, `Content-Type`, `X-LLMUI-Machine` (§5.4), `X-LLMUI-Web`. Exposed response headers: `X-LLMUI-Machine`, `X-LLMUI-Run-Id`, `X-LLMUI-Job-Id`.

### 2.2 Pairing — Stable

**Settings → Devices** in the web app: type a name (default "iPhone"), press **Pair a device**. That calls `POST /api/devices`, which creates a token for that device alone, and shows it as a QR code. The QR hides itself after 2 minutes (or on **Hide now**).

QR text (format unchanged from earlier versions; only the token is now per-device):

```
llmui-pair:v1:{"url":"https://box.tailde6c83.ts.net:8452","token":"<64 hex chars>"}
```

- The prefix `llmui-pair:v1:` is the version. The rest of the string is a JSON object.
- `url`: origin to use as the base URL. No trailing slash, no path.
- `token`: this device's bearer token.
- A client must reject any other prefix, including a later `llmui-pair:v2:`, and any body whose `url` or `token` isn't a string. Future versions may change the body entirely.
- **A token that is never used expires 10 minutes after it was created.** After scanning (or pasting), verify with `GET {url}/api/machines` and the token right away: 200 means paired (and marks the token used), 401 means it's wrong or expired.

**Paste instead of scanning.** Next to the QR code, **Copy pairing text** copies the exact same string the QR holds (same prefix, same JSON, same device token) and shows "Copied". The app should accept it from a paste field and parse it exactly like a scanned code: trim surrounding whitespace, then apply the rules above. Where the browser has no Clipboard API (e.g. the page was opened over plain HTTP), the web app shows the text in a selectable field instead. The same rules apply as for the QR: it's only shown after **Pair a device**, under the same full-access warning, and hidden after 2 minutes; a copied token that's never used still expires 10 minutes after it was created. Treat pasted text like a password: don't log it or keep it after pairing.

`POST /api/devices` with `{"name":"iPhone"}` (1–64 characters) → **201**:

```json
{"device":{"id":"3NV9QKgbKoWeHfNY2C2pC","name":"iPhone","createdAt":1795228960582,"lastUsedAt":null,"current":false},
 "token":"<token>","expiresIfUnusedAt":1795229560582,
 "pairing":{"version":"llmui-pair:v1","prefix":"llmui-pair:v1:","url":"https://box.tailde6c83.ts.net:8452"},
 "text":"llmui-pair:v1:{\"url\":\"https://box.tailde6c83.ts.net:8452\",\"token\":\"<token>\"}"}
```

(Captured with no public URL configured, where `pairing.url` and `text` were `null`; shown here as they look on the box.) `pairing.url` is `LLMUI_PUBLIC_URL` if set, else the first `https://` origin in `LLMUI_ALLOWED_ORIGINS` (the systemd unit sets it to the tailnet URL), else `null`. When it's `null`, `text` is `null` too and the web app builds the text with its own origin. `400 {"error":"name is required (1-64 characters)"}`.

### 2.3 Devices — Stable

| Method & path | Response |
|---|---|
| `GET /api/devices` | `{"devices":[{"id","name","createdAt","lastUsedAt","current"}]}`, newest first. `lastUsedAt` is null until first use and updated at most once a minute. `current` is true for the device making the request. |
| `DELETE /api/devices/:id` | `{"success":true}`, or `404 {"error":"Device not found"}`. The token stops working immediately. |

```json
{"devices":[{"id":"3NV9QKgbKoWeHfNY2C2pC","name":"iPhone","createdAt":1795228960582,"lastUsedAt":null,"current":false},
            {"id":"Yoy5NliBo5juUrTGo9QUY","name":"Test iPhone 2","createdAt":1795228900110,"lastUsedAt":1795228900134,"current":false}]}
```

### 2.4 How the web app signs in — Web-only

The browser never holds a token. On load it calls `POST /api/session`; the server answers with an `HttpOnly; SameSite=Strict` cookie (`Secure` over HTTPS) valid for 30 days, signed with a secret in `~/.llmui/session_secret`, and the body `{"identity":"tailscale:alice@example.com"}`. Every API request then sends the cookie plus the header `X-LLMUI-Web: 1`. If a request gets 401 (expired, or the secret was rotated), the app renews the session once and retries.

`POST /api/session` only issues a cookie when the TCP peer is loopback (Express listens on 127.0.0.1) **and** either:

- the request carries `Tailscale-User-Login`, i.e. it came through `tailscale serve` from a tailnet user. tailscale serve sets this header from the tailnet's own record of who is connecting, and removes any copy the client sent. It sets none for tagged devices or Funnel traffic; or
- it carries no proxy headers at all (`X-Forwarded-For`, `Forwarded`): a browser on the server itself, or the Vite dev server.

Anything else gets `403 {"error":"Open LLMUI through tailscale serve as a tailnet user, or from this machine","code":"not_allowed"}`. Set `LLMUI_TAILSCALE_USERS=alice@example.com,bob@example.com` to accept only those tailnet logins.

Why this design:

- **No token reaches an unauthenticated request.** The old `GET /api/llmui-token` handed the full token to anyone who could reach the port. Now the server checks who the caller is first, using an identity tailscale serve already verified, so there is no new login to manage.
- **The identity header is checked once, at sign-in, not on every request.** All other routes use the same check as native clients (a credential), and nothing else depends on proxy headers.
- **The cookie is HttpOnly, so page scripts can't read it.** Script injected through rendered model output can't steal a credential to use elsewhere.
- **`X-LLMUI-Web: 1` blocks cross-site request forgery.** A custom header forces a CORS preflight, and only allowed origins pass it, so another site can't make the browser send cookie-authenticated requests.

Limits:

- Cookies aren't isolated by port. Other web services served on `box.tailde6c83.ts.net` (other ports) receive the cookie if the browser visits them, and could replay it. Only run services you trust on that host name.
- Revoking a browser isn't per-device. Deleting `~/.llmui/session_secret` and restarting signs every browser out; tailnet users simply sign in again on the next load.

### 2.5 Other routes

| Route | Auth | Notes |
|---|---|---|
| `GET /health` | none | `{"status":"ok"}`. Fine as a reachability check. |
| `GET /api/llmui-token`, `GET /auth/token`, `GET /api/pairing` | — | **Removed.** They returned the shared server token. |

---

## 3. Chats

Chats are called *conversations* in the API. Messages live in a separate collection. Both are in SQLite on the server.

### 3.1 Conversation object

```json
{
  "id": "x_PJsXluxMdeX_Tjkqizt",
  "title": "New Chat",
  "model": "unsloth/Qwen3-8B-GGUF:Q4_K_M",
  "tags": [],
  "createdAt": 1795226797132,
  "updatedAt": 1795226797163,
  "archived": 0,
  "parentConversationId": null,
  "branchPointMessageId": null,
  "temperature": null,
  "maxTokens": null,
  "systemPrompt": null,
  "enableThinking": null,
  "isCompare": false,
  "compareModels": null,
  "source": "local",
  "messageCount": 2,
  "childBranchCount": 0,
  "activeRunId": null
}
```

- `archived` is `0`/`1` (an integer, not a boolean).
- `temperature`, `maxTokens`, `systemPrompt`, `enableThinking`: per-chat overrides. `null` means use the global setting (§10.1).
- `parentConversationId` / `branchPointMessageId`: set on branches (§3.8).
- `isCompare` / `compareModels`: web Compare mode. Treat these chats as read-only.
- `source`: `"local"` for chats made in LLMUI. Other values come from imports.
- `activeRunId`: the id of the run generating a reply in this chat right now (§4.2), else `null`. In the list and the single-chat response.

### 3.2 List — `GET /api/conversations` — Stable

Query: `page` (default 1), `limit` (default 50), `archived=true|false` (default false), `source` (optional filter). Sorted by `updatedAt` descending.

```json
{"conversations":[{ ...conversation object... }],"pagination":{"page":1,"limit":2,"total":1}}
```

### 3.3 Get — `GET /api/conversations/:id` — Stable

Returns the conversation object. `404 {"error":"Conversation not found"}`.

### 3.4 Create — `POST /api/conversations` — Stable

```json
{"model":"unsloth/Qwen3-8B-GGUF:Q4_K_M","title":"New Chat","tags":[]}
```

All fields are optional. `title` defaults to `"New Chat"`. Response:

```json
{"id":"x_PJsXluxMdeX_Tjkqizt","title":"New Chat","model":"unsloth/Qwen3-8B-GGUF:Q4_K_M","tags":[],"createdAt":1795226797132,"updatedAt":1795226797132,"messageCount":0,"archived":0,"isCompare":false,"compareModels":null,"source":"local"}
```

### 3.5 Rename / update — `PATCH /api/conversations/:id` — Stable

Any subset of these fields:

```json
{"title":"Arithmetic check","tags":["math"],"model":"...","archived":true,
 "temperature":0.5,"max_tokens":1024,"system_prompt":"Be brief.","enable_thinking":true}
```

The settings fields use **snake_case** here, unlike the camelCase response. Send `null` to clear an override.

Response: `{"success":true}`. Errors: `400 {"error":"No fields to update"}`, `404`.

### 3.6 Delete — `DELETE /api/conversations/:id` — Stable

Deletes the conversation and its messages. Branches of it remain, with `parentConversationId` set to null. Response: `{"success":true}`, or 404.

### 3.7 Messages

**Message object:**

```json
{"id":"hyr8O0YUAH3w_UU6wUZxD","role":"assistant","content":"4.","model":"unsloth/Qwen3-8B-GGUF:Q4_K_M","timestamp":1763683201000,"position":1,"tokensPerSec":31.8,"machine":"jellyfin","thinking":"The user asks a simple sum."}
```

- `role`: `user` | `assistant` | `system` | `tool`.
- `images` (optional): image attachments on user messages, as `[{"name":"a.png","type":"image/png","size":12345,"data":"<base64, no data: prefix>"}]`. The web app also stores a `preview` data URL. Native clients can omit it.
- `toolCalls` (optional): tool calls on assistant messages, as `[{"id","name","arguments":{},"status":"completed","result":...,"error":null}]`.
- `model`, `tokensPerSec`: assistant messages only.
- `thinking` (optional, string): the model's Think text, on assistant messages. Absent when there was none. Replies stored by a run (§4.1) include it; clients that save messages themselves can send it on `POST`, `PUT` and `PATCH`. It's copied into branches and exports, and it isn't sent back to the model as history.
- `machine` (string or `null`, always present): id of the machine that generated the reply (§5.1 `id`, e.g. `"jellyfin"`, `"workstation"`). Set by the server on every reply a run stores (§4.1: send, regenerate, answering an edit branch), including partial replies after cancel or error; if a turn fell back to another machine, it's that machine. `null` on user messages and on replies stored before this field existed (they are not backfilled; don't guess). Map it to a display name with `GET /api/machines`; show the id if it isn't listed. Clients that save messages themselves may send it on `POST` and `PUT` (`400 {"error":"machine must be a string"}` on `POST` otherwise); `PUT` must send back the value it read, or the value is lost. Copied into branches and exports. `model` on a run's reply is the model that run used.
- Not stored: `duration` and `promptPerSec`. The server drops any field not listed here.

| Method & path | Body | Response | Notes |
|---|---|---|---|
| `GET /api/conversations/:id/messages` | — | `{"messages":[...]}` ordered by `position` | 404 for unknown chat |
| `POST /api/conversations/:id/messages` | one message (`role` required; `id`, `timestamp` optional) | the stored message with `id`, `position` | Appends. If it's the first message, it's a user message and the title is still "New Chat", the title becomes the first 30 characters. 400 for a bad role, 404 for an unknown chat |
| `PUT /api/conversations/:id/messages` | `{"messages":[...]}` | `{"success":true,"count":2}` | **Replaces all** messages (positions renumbered 0..n-1). This is how the web app saves. Doesn't auto-title. |
| `PATCH /api/messages/:id` | `{"content"?, "tokensPerSec"?, "toolCalls"?, "thinking"?}` | `{"success":true}` | 400 if empty, 404 |
| `DELETE /api/messages/:id?truncateAfter=true` | — | `{"success":true}` | With `truncateAfter=true`, also deletes every later message. Without it, deletes one message and renumbers the rest. |

While a run is generating a reply in a chat (§4.1), `POST`, `PUT` and `DELETE` on that chat's messages return `409 {"error":"A reply is being generated in this chat; try again when it finishes","code":"run_in_progress","runId":"..."}`, so nothing rewrites the history under the reply. Deleting the chat itself cancels the run.

### 3.8 Branches, edit and regenerate

- **Edit a user message** → `POST /api/conversations/:id/branch` with `{"branchAtMessageId":"<user msg id>","editedContent":"new text"}`. This creates a **new conversation** (title `"Branch: <parent title>"`, same settings) containing the messages before that one, plus the edited user message. Then `POST /api/conversations/<new id>/send` with **no `content`** (§4.1) to answer it.
- **Branch without editing** → same call without `editedContent`. The new conversation contains messages up to and including `branchAtMessageId`.
- **Regenerate** the last reply → `POST /api/conversations/:id/send` with `{"regenerate":true}` (§4.1). The server deletes the trailing reply and answers again.

Branch response: the new conversation (`parentConversationId`, `branchPointMessageId`, `messageCount` set). Errors: `400 {"error":"branchAtMessageId is required"}`, `404 {"error":"Conversation not found"}`, `404 {"error":"Message not found in conversation"}`.

`GET /api/conversations/:id/branches` → `{"branches":[{"id","title","branchPointMessageId","createdAt","messageCount"}]}`, newest first.

---

## 4. Sending a message (streaming)

**Use §4.1.** The server stores the user message, builds the history from the database, runs the model (with tools if enabled), and stores the reply, whether or not the client stays connected. The client watches the run's event stream, and can drop it at any time (app in the background, network change) and reattach later by run id or chat id to get exactly what it missed (§4.2). Only an explicit cancel stops a run (§4.3).

§4.5 and §4.6 are the older client-managed endpoints: the client builds the history, streams, and saves the result itself, and closing the connection stops generation. They remain for the web Compare view and for compatibility.

A run goes to the selected machine, falling back to the default machine if the selected one is down (§5.3). It's refused with **409** while an image job holds that machine's GPU (§8.5).

### 4.1 Send — `POST /api/conversations/:id/send` — Stable

Request (every field optional):

```json
{
  "content": "What is 2+2?",
  "images": [{"name":"a.png","type":"image/png","data":"<base64>"}],
  "model": "Qwen/Qwen3-8B-GGUF:Q4_K_M",
  "enableThinking": true,
  "enabledTools": ["calculator"],
  "temperature": 0.7,
  "maxTokens": 2048,
  "systemPrompt": "Be brief.",
  "regenerate": false
}
```

What it does:

- `content` and/or `images` present: appends that user message (auto-titling a new chat, as in §3.7), then answers it. `images` may also be bare base64 strings. A vision model is needed (`sidecars` includes `mmproj`, §6.1).
- Neither present: answers the chat as it stands. Its last message must be a user message (e.g. a branch made by editing, §3.8), else `400 {"error":"Nothing to reply to: the chat doesn't end with a user message"}`.
- `"regenerate": true` (without `content`): deletes the trailing assistant reply, then answers.
- Settings: each field you send wins; otherwise the chat's override (§3.5), otherwise the global setting (§10.1). `model` falls back to the chat's model, then the global `defaultModel`. Tools: `enabledTools` if sent (`[]` = none), else the global `enabledTools` when global `enableTools` is on, else none. **Omitting tools never enables all of them** (unlike §4.6). The chat's `model` is updated to the model used.

Response: **200**, `Content-Type: application/x-ndjson`, headers `X-LLMUI-Run-Id: <run id>` and `X-LLMUI-Machine: <machine id>`. One JSON object per line, each with a `seq` (1, 2, 3, … per run). Blank lines are keepalives (every 15 s while idle); skip them. Real example (thinking on, no tools; middle elided):

```
{"seq":1,"type":"start","runId":"B0_BxUC664yuvDh_AUU8B","conversationId":"v0AEJAL2ZeskmZqMRmQN0","userMessageId":"tOLC9pwEsv_YaI5bCsE47","model":"test/fake-model-GGUF:Q4_K_M","machine":"jellyfin"}
{"seq":2,"type":"thinking","content":"Let "}
{"seq":3,"type":"thinking","content":"me "}
{"seq":4,"type":"thinking","content":"think "}
...
{"seq":48,"type":"content","content":"time. "}
{"seq":49,"type":"done","iterations":1,"machine":"jellyfin","timings":{"predicted_n":41,"predicted_ms":16400,"predicted_per_second":2.5,"prompt_n":20,"prompt_ms":40,"prompt_per_second":500},"messageId":"luR-q4Ei-N_TGThYCaUpk"}
```

| type | fields | notes |
|---|---|---|
| `start` | `runId`, `conversationId`, `userMessageId`, `model`, `machine` | Always first. `userMessageId` is the stored message being answered. |
| `thinking` | `content` | Think delta. |
| `content` | `content` | Answer delta. |
| `tool_call` | `id`, `name`, `arguments` | As in §4.6. |
| `tool_result` | `id`, `name`, `result`, `error` | As in §4.6. |
| `done` | `iterations`, `machine`, `timings`, `messageId` | **Normal end.** The reply is stored as `messageId`. |
| `error` | `error`, `messageId` | **Abnormal end** (model error, `"Max tool iterations reached"`). Whatever was produced before the error is stored as `messageId`; `null` if nothing was. |
| `cancelled` | `messageId` | **Ended by cancel** (§4.3). The partial reply is stored as `messageId` (`null` if empty). |

Exactly one of `done` / `error` / `cancelled` ends every run, and the stream closes after it. Ignore unknown types. The stored reply has `content`, `thinking`, `toolCalls`, `model`, `machine` and `tokensPerSec` (= `timings.predicted_per_second`). Fetch it with `GET /api/conversations/:id/messages` after the end event; don't save it yourself.

Refusals (plain JSON, nothing stored): `404 {"error":"Conversation not found"}`; `400` for `content must be a string`, `content is empty`, `regenerate can't be combined with content`, `enabledTools must be an array of tool names`, `temperature must be 0-5`, `maxTokens must be a positive integer`, `model is required (no model in the request, the chat or the settings)`, nothing to reply to (above); `409 {"error":"A reply is already being generated in this chat","code":"run_in_progress","runId":"..."}` (one run per chat at a time: reattach to `runId` instead); `409 {"error":"image generation in progress","code":"image_generation_in_progress"}`.

### 4.2 Reattach and status — Stable

| Method & path | Response |
|---|---|
| `GET /api/runs/:id/events?after=<seq>` | The same NDJSON stream: every event with `seq` greater than `after` (0 or omitted = from the start), then live events until the run ends. For a run that has already ended, the missed events and the end event, then the stream closes. |
| `GET /api/conversations/:id/run/events?after=<seq>` | Same, for the chat's current run, or its latest one if none is running. `404 {"error":"No run for this chat","code":"no_run"}`. |
| `GET /api/runs/:id` | Snapshot (below). |
| `GET /api/conversations/:id/run` | `{"run": <snapshot or null>}`: the chat's current run, else its latest one still kept. |

Snapshot (real; `content` shortened):

```json
{"id":"B0_BxUC664yuvDh_AUU8B","conversationId":"v0AEJAL2ZeskmZqMRmQN0","status":"completed","model":"test/fake-model-GGUF:Q4_K_M","machine":"jellyfin",
 "userMessageId":"tOLC9pwEsv_YaI5bCsE47","messageId":"luR-q4Ei-N_TGThYCaUpk","startedAt":1795228960619,"finishedAt":1795228977650,"error":null,"seq":49,
 "content":"This is a slow fake reply, streamed one …","thinking":"Let me think about this carefully. ","toolCalls":[],
 "timings":{"predicted_n":41,"predicted_ms":16400,"predicted_per_second":2.5,"prompt_n":20,"prompt_ms":40,"prompt_per_second":500}}
```

- `status`: `running` | `completed` | `failed` | `cancelled`.
- `content` / `thinking` / `toolCalls`: everything produced so far, so a client can draw the reply at once and then attach with `after=seq` for the rest.
- `messageId`: the stored reply once the run has ended (null while running, or if nothing was produced).

Runs are kept in server memory for **30 minutes** after they end (Unstable: may change). After that, or after a server restart, `/api/runs/:id` returns `404 {"error":"Run not found","code":"no_run"}`. The stored messages are then the record. A restart **loses a running run**: its user message stays stored with no reply, and `POST …/send` with no `content` answers it again.

**iOS pattern:** send (§4.1) and remember `runId` (from the header or `start`) and the last `seq`. When the app comes back, or the stream breaks: `GET /api/runs/:id` → if `running`, render `content`/`thinking` and attach with `after=<snapshot seq>`; if ended, reload the chat's messages. After a cold start, `activeRunId` on the conversation (§3.1) says which chats are still generating.

### 4.3 Cancel — `POST /api/runs/:id/cancel` — Stable

Stops the model and stores the partial reply. It answers with the snapshot once the run has ended (normally well under a second), or after 10 s with `status` still `running`. A run that has already ended is returned unchanged. Watchers get the `cancelled` event. `404` for an unknown run.

```json
{"id":"-ZfdrfyH96TsinPaYVBJZ","status":"cancelled","messageId":"ueJIaHIwAF9fnY-6E5Bv_","seq":8, "...":"rest of the snapshot"}
```

### 4.4 SSE instead of NDJSON — Stable

Add `?format=sse` to `POST …/send`, `GET /api/runs/:id/events` or `GET …/run/events` to get the same events as `data: <json>` SSE events (keepalives are `: ping` comments).

### 4.5 `POST /openai/v1/chat/completions` — Stable (format is llama.cpp's)

Request:

```json
{
  "model": "Qwen/Qwen3-8B-GGUF:Q4_K_M",
  "messages": [{"role":"system","content":"Be brief."},{"role":"user","content":"What is 2+2?"}],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 2048,
  "chat_template_kwargs": {"enable_thinking": true}
}
```

Send `Accept: text/event-stream`. The response header `X-LLMUI-Machine: jellyfin` names the machine that actually answered. Use it to tell whether the request fell back.

Stream: SSE, `data:` lines only, no `event:` names, blank line between events. This example is illustrative. Its shape is the one the web client parses:

```
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null}}],"model":"Qwen/Qwen3-8B-GGUF:Q4_K_M","object":"chat.completion.chunk"}

data: {"choices":[{"index":0,"delta":{"reasoning_content":"The user asks"}}],"object":"chat.completion.chunk"}

data: {"choices":[{"index":0,"delta":{"reasoning_content":" a simple sum."}}],"object":"chat.completion.chunk"}

data: {"choices":[{"index":0,"delta":{"content":"4"}}],"object":"chat.completion.chunk"}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"object":"chat.completion.chunk","timings":{"prompt_n":18,"prompt_ms":95.2,"prompt_per_second":189.1,"predicted_n":24,"predicted_ms":752.1,"predicted_per_second":31.9}}

data: [DONE]
```

- **Think**: `delta.reasoning_content`, only when `enable_thinking` is true and the model supports it. Show it separately from `delta.content`.
- **Speed**: the final chunk carries llama.cpp's `timings`. Use `predicted_per_second` as tok/s.
- **End**: `data: [DONE]`. Treat a connection that closes without `[DONE]` as done, too.
- **Errors before streaming**: non-2xx with `{"error":{"message":"..."}}`. Examples: `502 {"error":{"message":"Failed to connect to Jellyfin's model server"}}` and `409 {"error":{"message":"image generation in progress","code":"image_generation_in_progress","type":"conflict"}}`. Errors from llama.cpp (bad model id, context overflow) pass through with its status.
- **Errors mid-stream**: a `data: {"error":{"message":"..."}}` event.

`GET /openai/v1/models` passes through the router's list. Prefer `/api/llama/models` (§6.1).

### 4.6 `POST /api/chat-with-tools` — Stable

Request:

```json
{
  "model": "Qwen/Qwen3-8B-GGUF:Q4_K_M",
  "messages": [{"role":"user","content":"What's 17*23? Use the calculator."}],
  "enabledTools": ["calculator", "get_current_time"],
  "enableThinking": false,
  "options": {"modelOptions": {"temperature": 0.7, "num_predict": 2048}}
}
```

**Always send `enabledTools`.** If it's omitted or `null`, every tool is enabled, including `file_read` and `blender_execute`. Tool names: `web_search`, `fetch_url`, `get_current_time`, `calculator`, `file_read`, `blender_execute`.

Response: `Content-Type: application/x-ndjson`, one JSON object per line. The event types (a client should ignore unknown types):

```
{"type":"thinking","content":"I should use the calculator."}
{"type":"content","content":"Let me calculate that."}
{"type":"tool_call","id":"call_9Pq2...","name":"calculator","arguments":{"expression":"17*23"}}
{"type":"tool_result","id":"call_9Pq2...","name":"calculator","result":{"expression":"17*23","result":391,"type":"number"},"error":null}
{"type":"content","content":"17 × 23 = 391."}
{"type":"done","iterations":2,"machine":"jellyfin","timings":{"predicted_n":40,"predicted_ms":1260.4,"predicted_per_second":31.7,"prompt_n":210,"prompt_ms":820.2,"prompt_per_second":256.0}}
```

| type | fields | notes |
|---|---|---|
| `thinking` | `content` | Think delta (`enableThinking: true`). |
| `content` | `content` | Answer delta. Content from all model turns arrives in order. |
| `tool_call` | `id`, `name`, `arguments` (object) | Sent just before the tool runs. |
| `tool_result` | `id`, `name`, `result` (any JSON, or null), `error` (string, or null) | Matches `tool_call` by `id`. |
| `done` | `iterations`, `machine`, `timings` (summed over turns; may be null) | **Normal end.** `machine` is where it actually ran. |
| `error` | `error` (string) | **Abnormal end.** The stream closes after it. `"Max tool iterations reached"` after 5 model turns. |

Errors before the stream starts are plain JSON: `400 {"error":"Model is required"}`, `400 {"error":"messages must be an array"}`, `409 {"error":"image generation in progress","code":"image_generation_in_progress"}`.

When saving, store the answer text as `content`, the Think text as `thinking`, the calls as `toolCalls` and the `done` event's `machine` as `machine` (§3.7).

---

## 5. Machines

### 5.1 `GET /api/machines` — Stable

```json
{
  "selected": "jellyfin",
  "defaultId": "jellyfin",
  "effective": {"chat": "jellyfin", "image": "jellyfin"},
  "fallback": {"chat": null, "image": null},
  "machines": [
    {"id":"jellyfin","name":"Jellyfin","gpuLabel":"RX 580 8 GB · Vulkan","isDefault":true,
     "status":{"checkedAt":1795226798736,"online":true,
       "llama":{"ok":true,"error":null},
       "sd":{"ok":true,"error":null,"state":"empty"},
       "fetch":{"ok":true,"error":null,"busy":false,"version":"2"}}},
    {"id":"workstation","name":"Workstation","gpuLabel":"RTX 3070 8 GB · CUDA","isDefault":false,
     "status":{"checkedAt":1795226798735,"online":true,
       "llama":{"ok":true,"error":null},
       "sd":{"ok":true,"error":null,"state":"empty"},
       "fetch":{"ok":true,"error":null,"busy":false,"version":"2"}}}
  ]
}
```

- `status` is `null` until the first probe. The server probes every machine every 10 s.
- `llama`: chat model server. `sd`: image server (`state`: `empty` | `loading` | `ready` | `error`). `fetch`: the download and GPU-stats helper. Its `ok: null` means not configured.
- `online`: at least one service answered.

### 5.2 Select — `PUT /api/machines/selected` — Stable

`{"id":"workstation"}` → the same snapshot as §5.1, after a fresh probe of that machine. This only routes new requests. It never loads or unloads models. `400 {"error":"Unknown machine \"x\""}`.

### 5.3 Fallback notice — Stable

When the selected machine isn't the default and its chat (or image) service is down, those requests go to the default machine instead. The client sees this as:

- `fallback.chat` / `fallback.image` = `{"from":"workstation","reason":"ECONNREFUSED"}` in §5.1. Show a banner like "Workstation unreachable, using Jellyfin".
- `effective.chat` / `effective.image` = where requests go now.
- The per-request signals: the `X-LLMUI-Machine` response header (§4.1, §4.5), and `machine` in the `start` and `done` events (§4.1, §4.6).

### 5.4 Pinning a machine — Stable

Send `X-LLMUI-Machine: <id>` on model and image management calls (`/api/llama/*`, `/api/images/*`). If requests no longer go to that machine (the selection changed or a fallback kicked in), the server refuses instead of acting on another machine:

```
409 {"error":"Requests now go to Jellyfin, not Workstation; reload and try again","code":"machine_changed","machine":"jellyfin"}
```

The chat endpoints (§4) don't check this header.

---

## 6. Text models (per machine)

Chat models live on each machine's llama.cpp router. Model ids look like `owner/repo:QUANT` (Hugging Face).

`?machine=<id>` is accepted on `GET /api/llama/models`, `GET /api/llama/events`, `POST /api/llama/models` (download) and `DELETE /api/llama/models`. Load and unload always act on the selected machine (`400 "... can't target a machine; select it on the System page"`).

### 6.1 List — `GET /api/llama/models[?machine=id][&sizes=1]` — Stable

Trimmed example (Jellyfin; one entry shown):

```json
{
  "machine": {"id":"jellyfin","name":"Jellyfin","gpuLabel":"RX 580 8 GB · Vulkan","isDefault":true},
  "models": [{
    "id": "Qwen/Qwen3-8B-GGUF:Q4_K_M",
    "status": "sleeping",
    "failed": false,
    "exitCode": null,
    "canRemove": true,
    "memory": {"status":"measured",
      "min": {"n_ctx":8192,"devices":[{"kind":"device","name":"Vulkan0","model":4671766528,"context":1207959552,"compute":591409152,"total":8589934592,"free":8583933952},{"kind":"host","name":"Host","model":350060544,"context":0,"compute":54550528}]},
      "max": {"...": "same shape"},
      "effective": {"...": "same shape, null unless loaded"}},
    "contextLength": 8192,
    "size": 5021827072,
    "sidecars": []
  }],
  "gpu": {"name":"Vulkan0","total":8589934592,"source":"measured","margin":1073741824,"budget":7516192768}
}
```

- `status`: `loaded` | `loading` | `sleeping` (loaded but idle, wakes on the next request) | `unloading` | `unloaded` | `downloading` | `incomplete` | `unknown`. `failed: true` means the last load failed.
- GPU bytes a model needs = `model + context + compute` of the `kind: "device"` entry in `memory.min`. Compare that with `gpu.budget`.
- `sidecars: ["mmproj"]` = vision projector installed (the model accepts images). Such entries also carry `mmprojFileSize`.
- `?sizes=1` adds `diskSize` (bytes, from HF, or null). It's slower.
- `memory` is raw llama.cpp data. **Unstable.**

Errors: `502 {"error":"Jellyfin's model server unreachable: ECONNREFUSED"}`, `502` with an API-key hint.

### 6.2 Load / unload — `POST /api/llama/models/load|unload` — Stable

`{"model":"Qwen/Qwen3-8B-GGUF:Q4_K_M"}` → the router's JSON, passed through (typically `{"success":true}`). Load is gated like chat (409 during an image job). The router answers `400` "model is already running" for a model that's already loaded. `400 {"error":"Invalid model id (expected owner/repo or owner/repo:QUANT)"}`.

You don't have to load before chatting: a chat request autoloads its model, which takes time on the first token.

### 6.3 Download — `POST /api/llama/models[?machine=id]` — Unstable (progress format)

`{"model":"Qwen/Qwen3-8B-GGUF:Q4_K_M","sidecars":["mmproj"]}` starts a download and returns at once (router JSON passed through). `sidecars` is optional: `[]` skips the projector, and omitting it lets the router decide. `400 {"error":"Invalid sidecars (allowed: mmproj)"}`.

**Progress**, either way:

1. **Events**: `GET /api/llama/events[?machine=id]` (SSE). `: connected` arrives first, then a `: ping` comment every 20 s. Each event is a `data:` line holding JSON:
   ```
   data: {"type":"download_progress","model":"Qwen/Qwen3-8B-GGUF:Q4_K_M","data":{...raw router payload...},"progress":{"done":1048576000,"total":5027783488}}
   data: {"type":"download_finished","model":"Qwen/Qwen3-8B-GGUF:Q4_K_M","data":{...}}
   data: {"type":"download_failed","model":"...","data":{"error":"...","stopped":false}}
   ```
   `progress` (bytes, summed over the model's files) is computed by LLMUI and may be `null`. Other `type`s (model status changes) also arrive. The router's own event format has never been seen live, so treat `data` as opaque.
2. **Polling** (fallback, and the source of truth): `GET /api/llama/models` shows `status: "downloading"` (or `"incomplete"`) until the download is done. Poll every 5 s while one runs.

### 6.4 Delete — `DELETE /api/llama/models?model=<id>[&sidecar=mmproj][&machine=id]` — Stable

Removes the cached model, or only its projector when `sidecar=mmproj`. Router JSON is passed through. Check `canRemove` first.

### 6.5 Context size — `GET /api/llama/props?model=<id>` — Stable

`{"model":"Qwen/Qwen3-8B-GGUF:Q4_K_M","contextLength":8192,"loaded":false}`. Never autoloads. `404 {"error":"Unknown model"}`.

### 6.6 Hugging Face search — Stable

`GET /api/llama/hf/search?q=qwen3%208b` returns GGUF chat and vision repos, most downloaded first (up to 30):

```json
{"repos":[{"id":"Qwen/Qwen3-VL-8B-Instruct-GGUF","downloads":2363825,"likes":224,"pipelineTag":"image-text-to-text","updatedAt":"2025-10-31T02:50:31.000Z"},
          {"id":"Qwen/Qwen3-8B-GGUF","downloads":854157,"likes":408,"pipelineTag":"text-generation","updatedAt":"2025-05-03T06:33:59.000Z"}]}
```

`GET /api/llama/hf/files?repo=Qwen/Qwen3-8B-GGUF` returns the quants with their sizes. The install id is `repo + ":" + quant`.

```json
{"repo":"Qwen/Qwen3-8B-GGUF","hasMmproj":false,"mmprojSize":null,
 "quants":[{"quant":"Q4_K_M","size":5027783488,"files":["Qwen3-8B-Q4_K_M.gguf"]},
           {"quant":"Q5_0","size":5720761152,"files":["Qwen3-8B-Q5_0.gguf"]},
           {"quant":"Q8_0","size":8709518112,"files":["Qwen3-8B-Q8_0.gguf"]}]}
```

Errors: `400 {"error":"Invalid repo"}`, `404` (repo not found), `502 {"error":"Hugging Face unreachable: ..."}`.

---

## 7. Image models (per machine)

Image models are files on each machine's sd-server, installed through that machine's download helper. A model can only generate once it has a *setup*: a recipe plus any component files.

`?machine=<id>` is accepted on `GET /api/images/models`, `GET /api/images/options`, `GET /api/images/models/install/current`, `POST /api/images/models/install`, `POST /api/images/models/install/:id/cancel` and `DELETE /api/images/models/files/...`.

### 7.1 List — `GET /api/images/models[?machine=id]` — Stable

Trimmed example:

```json
{
  "machine": {"id":"jellyfin","name":"Jellyfin","gpuLabel":"RX 580 8 GB · Vulkan","isDefault":true},
  "configFile": "~/.llmui/sd_config.json",
  "files": [
    {"id":"checkpoints/sd_xl_turbo_1.0_fp16.safetensors","category":"checkpoints","name":"sd_xl_turbo_1.0_fp16.safetensors",
     "path":"checkpoints/sd_xl_turbo_1.0_fp16.safetensors","size":6938081905,"deletable":true,"inCatalog":true,"kind":"model",
     "setup":{"recipe":"sdxl-turbo","components":{"model":"checkpoints/sd_xl_turbo_1.0_fp16.safetensors"}},
     "isDefault":false,"loaded":false,"usedByDefault":false,"fit":"fits"},
    {"id":"checkpoints/sd15.safetensors","category":"checkpoints","name":"sd15.safetensors","path":"checkpoints/sd15.safetensors",
     "size":4265146304,"deletable":true,"inCatalog":true,"kind":"model",
     "setup":{"recipe":"sd1-checkpoint","components":{"model":"checkpoints/sd15.safetensors"}},
     "isDefault":true,"loaded":false,"usedByDefault":false,"fit":"fits"}
  ],
  "recipes": [{"id":"anima","name":"Anima","description":"...","primarySlot":"diffusion_model","primaryCategories":["diffusion_models"],
               "needs":[{"slots":["llm"],"label":"Qwen 3 0.6B Base Text Encoder","categories":["text_encoders"]}],
               "slots":[{"id":"diffusion_model","label":"Diffusion model","categories":["diffusion_models"],"required":true}],
               "defaults":{"width":1024,"height":1024,"steps":20,"cfgScale":4,"sampler":"euler"}}],
  "default": {"model":"checkpoints/sd15.safetensors","recipe":"sd1-checkpoint","components":{}},
  "gpuBytes": 8589934592,
  "sdError": null,
  "helper": {"configured":true,"reason":null,"ok":true,"error":null,"disk":{"free":123569684480,"total":210779168768,"reserve":10737418240},"hfToken":false}
}
```

- `kind`: `model` (checkpoint or diffusion model, which you can pick for generation) or `component` (VAE, text encoder, ...).
- `fit`: `fits` | `tight` | `nofit` | `unknown` against `gpuBytes`.
- `setup: null` means it can't generate yet (configure it with §7.5).
- Without `?machine=`, this also asks sd-server to rescan its folder.

### 7.2 Hugging Face search — `GET /api/images/models/hf/search?q=` — Stable

Text-to-image repos with single-file models, mapped to recipes (up to 25). This can take several seconds. Trimmed:

```json
{"machine":{"id":"jellyfin",...},"gpuBytes":8589934592,
 "repos":[{"id":"stabilityai/sdxl-turbo","sha":"71153311d3dbb46851df1931d3ca6e939de83304","downloads":563066,"likes":2673,"gated":false,"updatedAt":"2024-07-10T11:33:43.000Z",
   "files":[{"path":"sd_xl_turbo_1.0_fp16.safetensors","name":"sd_xl_turbo_1.0_fp16.safetensors","size":6938081905,"kind":"model","fit":"fits",
             "recipe":"sdxl-turbo","recipeName":"SDXL Turbo","how":"base model stabilityai/sdxl-turbo","reason":null,"category":"checkpoints","needs":[],"installed":true}]}]}
```

### 7.3 Download with progress — Stable

`POST /api/images/models/install` with the body below starts the job:

```json
{"repo":"stabilityai/sdxl-turbo","path":"sd_xl_turbo_1.0_fp16.safetensors","revision":"71153311d3dbb46851df1931d3ca6e939de83304","category":"checkpoints","recipe":"sdxl-turbo"}
```

Pass `recipe` (from the search result) to save the setup in the same step. The response is **202**, the helper's job plus `machine`:

```json
{"id":"3f9c...","repo":"stabilityai/sdxl-turbo","path":"sd_xl_turbo_1.0_fp16.safetensors","revision":"7115...","commit":"7115...","category":"checkpoints",
 "filename":"sd_xl_turbo_1.0_fp16.safetensors","file_id":"checkpoints/sd_xl_turbo_1.0_fp16.safetensors","state":"queued",
 "bytes_done":0,"bytes_total":null,"resumed_from":0,"sha256":null,"error":null,"created":1795226900.1,"finished":null,"machine":"jellyfin"}
```

To track progress, poll `GET /api/images/models/install/current[?machine=id]` once a second. It returns `{"job": <job or null>, "machine": "jellyfin"}`. `state`: `queued` → `downloading` → `verifying` → `completed` | `failed` | `cancelled`. Progress = `bytes_done / bytes_total` (`bytes_total` may be null at first). `created` and `finished` are Unix **seconds** (from the Python helper).

Cancel with `POST /api/images/models/install/<job id>/cancel`. The partial file is deleted.

Errors: `400 {"error":"invalid repo"}`, `409 {"error":"another download is running; one at a time"}` (or the file already exists), `507` (not enough disk space), `503` (helper not configured).

### 7.4 Delete — `DELETE /api/images/models/files/:category/:name` — Stable

For example, `DELETE /api/images/models/files/checkpoints/sd15.safetensors` returns the helper's JSON. Refusals: `409 {"error":"An image is being generated; try again when it finishes"}`, `409 {"error":"This is the default image model; make another model the default first"}`, `409 {"error":"The default image model uses this file; change the default first"}`.

### 7.5 Setup / default — `PUT /api/images/models/setup` — Stable

`{"model":"checkpoints/x.safetensors","recipe":"sdxl-turbo","components":{"vae":"vae/y.safetensors"},"makeDefault":true}` → `{"ok":true,"setup":{...},"defaults":{...},"isDefault":true}`. Always acts on the selected machine.

---

## 8. Images

### 8.1 Status — `GET /api/images/status` — Stable

```json
{"ok":true,"url":"http://100.118.190.15:8082","machine":{"id":"jellyfin","name":"Jellyfin","gpuLabel":"RX 580 8 GB · Vulkan","isDefault":true},"busy":false,"state":"empty"}
```

`busy: true` means an image job holds that machine's GPU. `ok: false` comes with `error` when sd-server is unreachable (still HTTP 200).

### 8.2 Options — `GET /api/images/options[?machine=id]` — Stable

These are the models you can generate with on that machine, plus the samplers, schedulers and defaults.

```json
{"machine":{"id":"jellyfin",...},
 "checkpoints":["checkpoints/sd15.safetensors","checkpoints/sd_xl_turbo_1.0_fp16.safetensors"],
 "modelDefaults":{"checkpoints/sd15.safetensors":{"steps":20,"width":512,"height":512,"cfgScale":7,"sampler":"euler_a"},
                  "checkpoints/sd_xl_turbo_1.0_fp16.safetensors":{"width":512,"height":512,"steps":1,"cfgScale":1}},
 "samplers":["euler","euler_a","heun","dpm2","dpm++2s_a","dpm++2m","lcm","ddim_trailing","..."],
 "schedulers":["default","discrete","karras","exponential","ays","..."],
 "defaults":{"checkpoint":"checkpoints/sd15.safetensors","steps":20,"width":512,"height":512,"cfgScale":7,"sampler":"euler_a"}}
```

`502 {"error":"..."}` if sd-server is unreachable.

### 8.3 Generate — Stable

Generation is a **job**: it gets an id, owns the machine's GPU until it ends, and runs whether or not anyone is watching. **Closing a connection never cancels a job**; only `POST /api/images/jobs/:id/cancel` does (§8.4). Start one either way:

- `POST /api/images/jobs`: answers **202** at once with the job's snapshot (§8.4). Best for iOS: then poll the snapshot, or watch its events.
- `POST /api/images/txt2img`: starts the job and streams its events (SSE) on the same response, with header `X-LLMUI-Job-Id`. Hanging up just stops watching.

Both take the same body. Request (everything except `prompt` falls back to the machine's defaults):

```json
{"prompt":"a lighthouse on a cliff at dusk, oil painting","negativePrompt":"blurry","checkpoint":"checkpoints/sd15.safetensors",
 "width":512,"height":512,"steps":20,"cfgScale":7,"sampler":"euler_a","scheduler":null,"seed":-1,"batchCount":1}
```

Limits: width and height are multiples of 8 from 64 to 2048. `steps` 1–150, `cfgScale` 1–30, `batchCount` 1–4. `seed` is -1 (random; the server picks it and reports it) or 0..2³²-1.

Rejected before the job starts (plain JSON, nothing runs):

| Status | Body |
|---|---|
| 400 | `{"error":"prompt is required"}` (or another validation message) |
| 400 | `{"error":"No image model on Workstation; install one under Models → Image","code":"no_model"}` |
| 400 | `{"error":"checkpoints/x isn't on Jellyfin; install it under Models → Image","code":"no_model"}` |
| 409 | `{"error":"image generation in progress","code":"gpu_busy"}`: another job holds this GPU |
| 409 | `{"error":"a chat response is still streaming; try again when it finishes","code":"gpu_busy"}` |
| 502 | `{"error":"..."}`: sd-server unreachable |

Events (SSE: one `data:` line of JSON per event, blank line between; `: ping` comments every 15 s while idle). Each has a `seq` (1, 2, 3, … per job). Real example (fake sd-server, 3 steps; repeated keepalive stages elided):

```
data: {"seq":1,"type":"job","jobId":"_mxS2ASxJ81M_aU9fD_TJ","machine":"jellyfin"}

data: {"seq":2,"type":"stage","stage":"freeing_gpu","message":"Unloading chat models on Jellyfin…"}

data: {"seq":3,"type":"stage","stage":"freeing_gpu","message":"Waiting for test/fake-model-GGUF:Q4_K_M (loaded) to unload…"}

data: {"seq":4,"type":"stage","stage":"loading_model","message":"Loading checkpoints/sd15.safetensors…"}

data: {"seq":7,"type":"progress","stage":"sampling","step":1,"totalSteps":3,"pass":1,"value":0.3333333333333333}

data: {"seq":11,"type":"complete","machine":"jellyfin","generationId":"cvRS1cWdIJUXv3FI0p-rX","imageIds":["ui1OeQxCSTTgLyBqDYxYM"],"seed":1366911423,"imageCount":1,"api":"sdcpp","timings":{"totalMs":4535,"generateMs":3019}}
```

- `job`: always first; the job id.
- `stage`: `freeing_gpu`, `loading_model` (repeated every 5 s while loading, as a keepalive).
- `progress`: `stage` is `queued` | `preparing` | `sampling` | `vae_decode` | …. `value` is overall progress 0..1 across the batch, or null when unknown. `pass` is which image of the batch (1-based).
- Exactly one end event, then the stream closes: **`complete`** (fetch the images, §8.7), **`error`** `{"error":"sd-server job failed: ..."}`, or **`cancelled`** (after §8.4's cancel).
- After a job ends, either way, the SD model is unloaded and the GPU is freed for chat. The chat model is *not* reloaded until the next chat request.

### 8.4 Jobs — Stable

| Method & path | Response |
|---|---|
| `GET /api/images/jobs/:id` | Snapshot (below). |
| `GET /api/images/jobs/:id/events?after=<seq>` | SSE: events with `seq` > `after` (0 = from the start), then live until the end event. For an ended job: the missed events and the end event. |
| `GET /api/images/jobs/:id/result` | Completed: `{jobId, machine, generationId, imageIds, seed, imageCount, api, timings, images:[{id, url, metaUrl}]}`. Otherwise `409` with `code` `job_running`, `job_failed` or `job_cancelled` (and `status`). |
| `POST /api/images/jobs/:id/cancel` | Stops the job (sd-server cancels it, the SD model is unloaded, the GPU freed) and answers with the snapshot once it has ended (`status: "cancelled"`), or after 30 s with `status` still `running`. An ended job is returned unchanged. |
| `GET /api/images/jobs[?active=1]` | `{"jobs":[snapshot, ...]}` newest first: jobs the server still holds; `active=1` only running ones. Use it after a restart of the app to find a job it lost track of. |

Unknown ids: `404 {"error":"Job not found","code":"no_job"}`.

Snapshot (real, while sampling):

```json
{"id":"_mxS2ASxJ81M_aU9fD_TJ","status":"running","machine":"jellyfin",
 "params":{"prompt":"a lighthouse on a cliff at dusk, oil painting","negativePrompt":"","checkpoint":"checkpoints/sd15.safetensors","width":512,"height":512,"steps":3,"cfgScale":7,"sampler":"euler_a","scheduler":null,"seed":1366911423,"batchCount":1},
 "stage":"sampling","message":"","progress":{"stage":"sampling","step":0,"totalSteps":3,"pass":1,"value":0},
 "createdAt":1795228985807,"finishedAt":null,"error":null,"result":null,"seq":6}
```

- `status`: `running` | `completed` | `failed` | `cancelled`. `progress` is the last `progress` event; `stage`/`message` the current stage.
- `result` (when completed): `{generationId, imageIds, seed, imageCount, api, timings}`.

Result (real):

```json
{"jobId":"_mxS2ASxJ81M_aU9fD_TJ","machine":"jellyfin","generationId":"cvRS1cWdIJUXv3FI0p-rX","imageIds":["ui1OeQxCSTTgLyBqDYxYM"],"seed":1366911423,"imageCount":1,"api":"sdcpp",
 "timings":{"totalMs":4535,"generateMs":3019},
 "images":[{"id":"ui1OeQxCSTTgLyBqDYxYM","url":"/api/images/generations/cvRS1cWdIJUXv3FI0p-rX/images/ui1OeQxCSTTgLyBqDYxYM","metaUrl":"/api/images/generations/cvRS1cWdIJUXv3FI0p-rX/images/ui1OeQxCSTTgLyBqDYxYM/meta"}]}
```

Jobs stay in server memory for **1 hour** after they end (Unstable: may change). A completed job's generation records its job id, so `GET /api/images/jobs/:id` and `/result` still answer for it after that, and after a restart (with `params`, `createdAt` and `seq` null). A failed or cancelled job is forgotten. A server restart loses a running job.

**iOS pattern:** `POST /api/images/jobs`, keep the id. While in the foreground, watch `/events` (or poll the snapshot every 1–2 s). When the app comes back, `GET` the snapshot: still `running` → watch `/events?after=<seq>`; `completed` → `/result`.

### 8.5 409 behaviour while a job runs — Stable

While a job runs on machine M (`/api/images/status` → `busy: true`), these requests to M return 409:

- `POST /api/conversations/:id/send` and `POST /api/chat-with-tools` → `{"error":"image generation in progress","code":"image_generation_in_progress"}`
- `POST /openai/v1/chat/completions` → `{"error":{"message":"image generation in progress","code":"image_generation_in_progress","type":"conflict"}}`
- `POST /api/llama/models/load` → same as chat-with-tools
- `POST /api/images/jobs`, `POST /api/images/txt2img` → `{"error":"image generation in progress","code":"gpu_busy"}`
- `DELETE /api/images/models/files/...` → `{"error":"An image is being generated; try again when it finishes"}`

Likewise, a job can't start while a chat reply (§4) is being generated on M: `409 {"error":"a chat response is still streaming; try again when it finishes","code":"gpu_busy"}`. The other machine is unaffected. The iOS app should disable Send while `busy` and retry after the job ends.

### 8.6 History list — `GET /api/images/generations?page=1&limit=20` — Stable

`limit` maxes out at 100. Newest first. The fields are **snake_case** (database columns).

```json
{"generations":[{"id":"0Foi-r9i02OlKlYKIfx_9","prompt":"a lighthouse on a cliff at dusk, oil painting","negative_prompt":"blurry",
  "model":"checkpoints/sd15.safetensors","width":512,"height":512,"steps":20,"cfg_scale":7,"sampler":"euler_a","scheduler":null,
  "seed":1234567890,"batch_count":1,"created_at":1795226834282,"machine_id":"jellyfin","machine_name":"Jellyfin","recipe":"sd1-checkpoint",
  "image_count":1,"first_image_id":"tCmbP-dcb8eF1-PbS9ZoV","image_ids":["tCmbP-dcb8eF1-PbS9ZoV"]}],
 "total":1,"page":1,"limit":1}
```

`machine_id`, `machine_name` and `recipe` are null for images generated before they were recorded.

`GET /api/images/generations/:id` returns one generation's raw row plus `images: [{id, filename, width, height, position, created_at}]`. **Web-only**: it includes internal JSON strings (`workflow_json`, `components_json`). Use §8.8 instead.

`DELETE /api/images/generations/:id` → `{"success":true}`. It deletes the generation and its images, and succeeds even if the id is unknown.

### 8.7 Fetch image bytes — `GET /api/images/generations/:genId/images/:imageId` — Stable

Returns the PNG bytes (`Content-Type: image/png`, or `image/jpeg` for jpg files) with `Cache-Control: private, max-age=31536000, immutable`, so cache it forever by URL. `404 {"error":"Image not found"}`. Requires the bearer header like everything else, so no plain `<img src>` loading.

### 8.8 Image details — `GET /api/images/generations/:genId/images/:imageId/meta` — Stable

Everything known about one stored image, versioned by `schema`. A field that wasn't recorded is `null`, never guessed.

```json
{
  "schema": "llmui.image/v1",
  "id": "tCmbP-dcb8eF1-PbS9ZoV",
  "generationId": "0Foi-r9i02OlKlYKIfx_9",
  "position": 0,
  "imageCount": 1,
  "createdAt": 1795226834282,
  "mimeType": "image/png",
  "fileSize": 1874,
  "width": 512,
  "height": 512,
  "prompt": "a lighthouse on a cliff at dusk, oil painting",
  "negativePrompt": "blurry",
  "model": "checkpoints/sd15.safetensors",
  "recipe": "sd1-checkpoint",
  "components": {"model": "checkpoints/sd15.safetensors"},
  "machine": {"id": "jellyfin", "name": "Jellyfin"},
  "settings": {"seed": 1234567890, "steps": 20, "cfgScale": 7, "sampler": "euler_a", "scheduler": null, "width": 512, "height": 512, "batchCount": 1},
  "timings": {"totalMs": 23410, "generateMs": 21032}
}
```

- `fileSize`: bytes of the stored file. `width`/`height`: read from the PNG header, which gives the actual pixel size.
- `machine`: which server generated it. It's null for old images.
- `settings.width/height`: what was requested.
- `timings`: null for old images.

`404 {"error":"Image not found"}`.

---

## 9. GPU stats

### `GET /api/gpu[?machine=id]` — Stable

Live stats from a machine's helper. Without `?machine`, the machine chat currently goes to. Reading stats never wakes a GPU or routes work to it. Both examples are real:

```json
{"ok":true,"machine":"jellyfin","source":"amdgpu-sysfs","error":null,
 "gpus":[{"index":0,"name":"Radeon RX 470/480/570/580","vendor":"amd","state":"asleep",
          "temperature":null,"utilization":null,"memoryUsed":5,"memoryTotal":8192,"powerDraw":null}],
 "timestamp":1795226807046}
```

```json
{"ok":true,"machine":"workstation","source":"nvidia-smi","error":null,
 "gpus":[{"index":0,"name":"NVIDIA GeForce RTX 3070","vendor":"nvidia","state":"active",
          "temperature":40,"utilization":3,"memoryUsed":981,"memoryTotal":8192,"powerDraw":35.1}],
 "timestamp":1795226807074}
```

- `state`: `"active"` or `"asleep"`. **asleep** = an AMD card that has runtime-suspended. Only VRAM is read then, so `temperature`, `utilization` and `powerDraw` are `null`. Show it as "Asleep", not as zeros. It wakes on its own when work arrives.
- Units: `memoryUsed` and `memoryTotal` in MiB, `temperature` in °C, `utilization` in %, `powerDraw` in W. Any value may be `null`.
- `error`: a partial-read note from the helper (HTTP is still 200).
- Failures: `404 {"ok":false,"error":"Unknown machine"}`, `502 {"ok":false,"machine":"jellyfin","error":"Jellyfin download helper unreachable (...)"}`, `503` (helper not configured).

`GET /api/hardware` (CPU/RAM of the LLMUI host, used by the setup wizard) is **web-only**.

---

## 10. Other endpoints

### 10.1 Global chat settings — Stable (key), Web-only (others)

The web app keeps its global settings in one settings key:

`GET /api/settings/llmui_settings` returns:

```json
{"data":{"defaultModel":"","systemPrompt":"","temperature":0.7,"maxTokens":2048,"customTags":[],"enableThinking":false,"enableTools":false,"enabledTools":["web_search","get_current_time"],"theme":"dark"}}
```

`data` is `null` before the first save. `PUT /api/settings/llmui_settings` takes `{"data":{...}}` and replaces the whole object. This is shared with the web app, so read, merge, then write. Other keys (`llmui_active_conversation`, ...) are web-only.

### 10.2 Search — `GET /api/search?q=<fts query>[&conversation_id=][&limit=50]` — Stable

Full-text search over message content: `{"results":[...]}`. `400 {"error":"Invalid search query","details":"..."}` for bad FTS5 syntax.

### 10.3 Web-only

`/storage/:key`, `/api/gpu-config`, `/api/hardware`, `/api/setup/*`, `/api/backup*`, `/api/export*`, `/api/import`, `POST /api/session`.

---

## 11. Known gaps

Closed in this revision: server-side send (§4.1), image jobs that outlive the connection (§8.3), stored Think text (§3.7), per-device tokens with revocation and no unauthenticated token route (§2).

Still open:

1. **Runs and jobs don't survive a server restart.** They live in memory. A restart loses a running reply or image job (the user message stays stored; send again with no `content`). Finished ones are only reattachable for 30 min (runs) or 1 h (jobs); after that, read the stored messages / images.
2. **Text-model download events are unverified.** The router's `/models/sse` format was never observed live (§6.3). Rely on polling.
3. **Mixed casing.** Conversations are camelCase. `PATCH` settings fields, image history and helper jobs are snake_case. A future `v2` could normalize these; nothing has been renamed, to avoid breaking the web app.
4. **No push.** There are no notifications or websockets. Everything is polling plus the event streams; a finished run or job doesn't notify a backgrounded app.
5. **No token scopes or expiry.** Every device token has full access until revoked (unused ones expire after 10 minutes). The web Compare view still uses the client-managed endpoints (§4.5), so its replies aren't stored server-side.

## Changes

### 2026-11-20 (third revision)

- **New:** `machine` on every message (§3.7): the machine that generated the reply, stored by runs (send, regenerate, edit branches). `null` on user messages and on replies from before this revision (not backfilled). Accepted on `POST`/`PUT`, copied into branches and exports. The web app shows it next to the model on each reply.
- **New:** Settings → Devices → **Copy pairing text** (§2.2): the QR's exact `llmui-pair:v1` string, for pasting into the app. Same token, same 2-minute display and 10-minute unused expiry.
- Server: the database is copied to `~/.llmui/backups/llmui_pre-migration-<versions>_<time>.db` before any schema migration runs (this one adds `messages.machine_id`).

### 2026-11-20 (second revision)

- **New:** `POST /api/conversations/:id/send`, `GET /api/runs/:id[/events]`, `GET /api/conversations/:id/run[/events]`, `POST /api/runs/:id/cancel` (§4.1–4.4). The web app sends, regenerates and answers edit branches through them, and reattaches to a running reply after a reload.
- **New:** image jobs: `POST /api/images/jobs`, `GET /api/images/jobs[/:id[/events|/result]]`, `POST /api/images/jobs/:id/cancel` (§8.3–8.4). **Changed:** closing the `txt2img` stream no longer cancels the job; its events gained `seq`, a first `job` event and a `cancelled` end event. Cancelling during "freeing GPU" now stops at once instead of waiting for the chat models to unload.
- **New:** `thinking` on messages (§3.7). The web app shows it, collapsed, on stored replies and live while streaming.
- **New:** per-device tokens: `POST /api/devices` (pairing), `GET /api/devices`, `DELETE /api/devices/:id` (§2.2–2.3); Settings → Devices. The QR format stays `llmui-pair:v1`; its token is now the device's own.
- **New:** browser sessions: `POST /api/session` and the `X-LLMUI-Web` header (§2.4).
- **Removed:** `GET /api/llmui-token`, `GET /auth/token`, `GET /api/pairing`. They all returned the shared server token.
- **Changed:** `POST`/`PUT`/`DELETE` on a chat's messages return 409 `run_in_progress` while a reply is being generated there. Conversations include `activeRunId`.
- Web fix: Settings → Import sent a stale `localStorage` token and always failed with 401; it now uses the session.

### 2026-11-20 (first revision)

- `/api/chat-with-tools` now streams Think as `{"type":"thinking"}` events. Before, they were silently dropped.
- Router `download_progress` events carry a normalized `progress: {done, total}`.
- Unhandled errors (bad JSON, DB constraints) return JSON instead of Express's HTML page.
- Message routes return 404 for an unknown conversation (they used to return `[]`, or a 500 on write). `POST` validates `role`.
- `GET /api/conversations/:id` includes `source`. The image history list includes `machine_id`, `machine_name` and `recipe`.
- Web fix: renaming a chat, changing its tags, or switching its model now saves to the server. Before, it only changed the open tab.
- New: `GET /api/pairing` and Settings → Pair iPhone (§2.2).
