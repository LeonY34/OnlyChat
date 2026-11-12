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
- Optional access password, mobile-friendly layout, automatic dark mode

## Running it

```bash
node server.js            # Node >= 20, listens on 127.0.0.1:8080 by default
```

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Listen address |
| `DATA_DIR` | `./data` | Where chats, images, and settings (including API keys) are stored |
| `ONLYCHAT_PASSWORD` | empty | If set, the UI asks for a password |
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
data/settings.json        providers (including API keys), default model, title model, system prompt
data/chats/<id>.json      one file per chat
data/uploads/<id>.<ext>   uploaded images (deleted together with their chat)
```
