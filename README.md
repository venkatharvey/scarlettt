# Scarlettt

A desktop app for chatting with open-source LLMs that run entirely on your own
machine. It manages its own [Ollama](https://ollama.com) runtime — no account,
no API key, and nothing leaves the device to hold a conversation.

Built with Tauri 2: a React frontend, and a Rust backend that owns the model
runtime, chat storage and the machine's memory picture.

## Features

- **Local chat** with any model Ollama can run, streamed token by token and
  saved to a local SQLite database.
- **Model library** browsed live from ollama.com — search, pull with progress,
  and see size, capabilities and whether a model fits in memory *before*
  downloading.
- **Memory-aware context sizing.** Ollama gives every model a 4096-token window
  regardless of what it supports; Scarlettt sizes it to the machine instead.
- **Context usage meter** under the model in use, with notices at 80%, 90% and
  when the window is full.
- **Chat organisation** — folders, pinning, search, branching from any message,
  and chat import.
- **Offline mode** that stops all outbound requests while leaving chat working.

## Requirements

| | |
|---|---|
| Node.js | 20.19+ or 22.12+ (Vite 7's requirement) |
| Rust | stable, plus the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) |
| OS | macOS. The Ollama downloader has Windows and Linux paths, but the window chrome and signature check are macOS-only. |

Ollama is **not** a prerequisite. The app downloads and manages its own copy on
first run, and uses an existing one on `PATH` if you have it.

## Getting started

```bash
npm install
npm run tauri dev
```

This builds the Rust backend, starts Vite on port 1420 and opens the native
window. The first build takes a few minutes; later runs are incremental.

```bash
npm run dev          # frontend only, in a browser
npx tsc --noEmit     # typecheck — run after every change
npm run tauri build  # bundled .app
```

## How it works

| | |
|---|---|
| Frontend | React 19, Vite 7, TypeScript, Tailwind 3 |
| Backend | Rust, Tauri 2, `rusqlite` |
| Dev server | port 1420 (fixed — `strictPort`) |
| Ollama | port 11435, clear of a system Ollama on the default 11434 |
| Bundle id | `com.scarlettt` |

The frontend never calls Ollama directly. Everything goes through a Tauri
command in `src-tauri/src/`:

```
lib.rs         app setup and every Tauri command
ollama.rs      runtime lifecycle, model APIs, ollama.com scraping
database.rs    SQLite schema and queries
system.rs      memory, CPU and GPU readings
```

Chats, folders and the managed Ollama binary live in the application-data
directory for `com.scarlettt`; `scarlettt.db` holds the conversations.

### Context length

Memory cost is **weights + KV cache**, and the cache grows linearly with the
context. Settings offers two modes:

- **Auto** — the largest window that still leaves the machine comfortable.
- **Fixed** — one ceiling for every model, capped at what each supports.

Auto budgets against **free** memory rather than total, since total RAM assumes
an empty machine. It takes the lowest of four limits — a share of total RAM, the
GPU working set, free memory, and any reserve you set. The fit badge checks the
same limits, so Auto cannot propose a window its own badge then rejects.

Per-token cost comes from the model's architecture via `/api/show`, falling back
to a size-based estimate — never to Ollama's 4096 default, which would cripple a
262k-capable model.

The usage meter reports `prompt_eval_count` from the last reply, so it is
measured rather than estimated, and updates as replies land. Past a full window
Ollama drops the oldest messages, which is what the final notice reports.

To confirm what actually loaded:

```bash
OLLAMA_HOST=127.0.0.1:11435 ollama ps
```

The CONTEXT column is ground truth. Settings shows the same data, including
whether the model spilled onto the CPU.

### Ollama runtime

- A **minimum version** is enforced. Below it the binary is treated as absent
  and replaced — the registry rejects old clients with an HTTP 412 that
  otherwise surfaces as models mysteriously failing to download.
- Only a binary in the app's own data directory is ever replaced. A system
  Ollama on `PATH` is reported, never overwritten.
- On macOS a downloaded binary's **code signature is verified** before it is
  first executed: `codesign --verify` must pass, and the signing team must be
  Ollama's.

### Offline mode

Every outbound request funnels through one function (`fetch_url`), which is what
makes the switch enforceable and auditable. Local Ollama traffic deliberately
does not, so chat keeps working.

Two limits, stated in the UI as well: it is the app choosing not to call out,
**not a firewall**; and the Ollama subprocess has its own network access that
cannot be revoked here, which is why model pulls are refused before Ollama is
asked.

## Development notes

- **Icons are inline SVG React components** in `src/svg/`. Don't add `.svg`
  assets — keep the path data in the component.
- **`tauri.conf.json` changes need a full restart.** HMR only reloads frontend
  code.
- **The dev binary is `src-tauri/target/debug/Scarlettt`.** `productName` and the
  `[[bin]]` name must stay in sync — `tauri dev` has no bundle, so macOS shows
  the executable name in the menu bar.
- **Killing `npm run tauri dev` orphans processes.** Vite holds port 1420 and
  `ollama serve` is re-parented, so the next run fails on the port while the old
  server still answers:

  ```bash
  lsof -ti:1420 | xargs kill; pkill -f "com.scarlettt/ollama"
  ```

- **The browser preview is not proof for anything data-driven.** `npm run dev`
  mocks the Tauri bridge (`src/devTauriMock.ts`) so layout and streaming can be
  worked on in a browser, but it always returns a size, a version and invented
  hardware. Check the native app for anything that depends on real data.
