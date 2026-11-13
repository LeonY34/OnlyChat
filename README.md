# OnlyChat

A very small, self-hosted AI chat UI. **Zero npm dependencies**: one Node.js file for the server and a frontend in plain JS. It uses about 30MB of memory.

## Features

- **Three API formats**, each with its own Base URL:
  - OpenAI Chat Completions (`/chat/completions`), which works with almost every OpenAI-compatible gateway
  - OpenAI Responses (`/responses`)
  - Anthropic Messages (`/v1/messages`)
- **Server-side chat history** (JSON files), shared across devices. After the first reply, the API is called once to **generate a chat title automatically** (you can choose which model generates titles)
- **Image upload**: click, paste, or drag and drop. The browser compresses images to a 2048px max edge first
- **Native web search from the API itself** (no third-party search service):
  - Anthropic: the server-side `web_search` tool (`web_search_20260209` on newer models; it falls back to `web_search_20250305` automatically if a model doesn't support it), with `pause_turn` continuation handled automatically
  - OpenAI Responses: `tools: [{type: "web_search"}]`
  - OpenAI Chat Completions: `web_search_options: {}` by default (for the gpt-*-search family). Other gateways can override this per provider, for example Qwen `{"enable_search": true}` or OpenRouter `{"plugins":[{"id":"web"}]}`
  - Sources are shown as links under each reply
- Shows reasoning/thinking output (`reasoning_content`, Anthropic thinking summaries, Responses reasoning summaries); an optional "Thinking" toggle
- Streaming output, stop, regenerate, editing a message and resending, delete, pin, rename, search
- Generation continues on the server and is saved there even if the browser disconnects
- **Multi-user accounts**: admins create users (with optional generated strong passwords) and promote users to admins. Admins cannot demote anyone or access another user's chats, attachments, private keys, or personal settings.
- **Per-user API keys**: private or shared, chosen permanently at creation. Only the creator can view/edit the secret or stop/restore service; stopping keeps history. Shared keys are usable by all accounts, never exposed as plaintext to other users.
- **Shared-key token leaderboard**: cached input, non-cached input (including cache writes), output and total, ranked by total with expandable per-user totals. Counts only calls through this installation, including automatic titles. Missing cache details are marked as unknown; upstream calls that supply no usage cannot be counted. Imported chats do not affect usage.
- **Chat import/export**: portable OnlyChat JSON including images, either one chat or all your chats. Imports create fresh chats and image IDs in your own account, never overwrite existing chats. Import limit: 100MB per JSON file, 20MB per image.
- Account login, mobile-friendly layout, automatic dark mode

## Running it

```bash
node server.js            # Node >= 20, listens on 127.0.0.1:8080 by default
```

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Listen address |
| `DATA_DIR` | `./data` | Private persistent data directory; back up the entire directory, especially `encryption.key` |
| `ONLYCHAT_PASSWORD` | empty | Initial `admin` administrator password, used only on the first launch. If absent, a random password is printed to the server startup log. This variable does not reset existing account passwords. |
| `CANONICAL_URL` | empty | e.g. `https://host.tailnet.ts.net`. Requests that use a short hostname (such as `http://host`) are 301-redirected to this address |
| `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` | - | Node 24+ sends upstream requests through this proxy |

Open the UI, then go to **Settings** and add a provider (Base URL, API key, models). Models can be listed from `/models` or entered by hand.

Base URL conventions: for OpenAI, include `/v1` (e.g. `https://api.openai.com/v1`). For Anthropic, `https://api.anthropic.com` works with or without `/v1`.

## Deployment (systemd)

```bash
deploy/deploy.sh <ssh-host>   # copies to /opt/onlychat/app, installs and restarts onlychat.service
```

The service expects a Node binary at `/opt/onlychat/node`. Data is stored in `/var/lib/onlychat`.

## Data layout

```
data/accounts.json                users, scrypt password hashes, sessions, encrypted keys, personal settings and cumulative usage
 data/encryption.key               AES-256-GCM master key (0600; losing this makes API keys unrecoverable)
 data/chats/<id>.json               chat with immutable owner ID
 data/uploads/<user-id>/<id>.<ext>  user-isolated uploaded images
```

On the first upgrade from the single-user version, all old chats, images and settings are assigned to the initial admin **admin**. Existing API keys become **private** and are encrypted before the old plaintext `settings.json` is removed. Back up the data directory **before** upgrading. Old chat-message usage is retained in messages but is not retroactively attributed to the leaderboard (old records cannot reliably identify the key/user).

New passwords require 14–256 characters and at least three of lowercase, uppercase, digits and symbols. Existing legacy passwords are accepted for migration; change yours in Account after upgrading. Password changes invalidate all sessions. Sessions are random, expire after 30 days, and are stored as hashes. Use HTTPS: cookies are Secure when `CANONICAL_URL` is HTTPS. Key encryption protects files at rest, not against the server's root/operator who can access the master key.

Run regression tests (local mock upstream only, no billable calls):

```bash
node --test test/*.test.js
```
