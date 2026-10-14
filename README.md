# AnythingLLM

[![Deploy on velixir](https://velixir.net/img/deploy-on-velixir.svg)](https://velixir.net/new?template=anythingllm)

Chat with your own documents using the AI model you choose. [AnythingLLM](https://anythingllm.com)
gives you a private, ChatGPT-style workspace: upload PDFs, Word files, spreadsheets, notes or web
pages, then ask questions and get answers that cite their sources. This template runs it in the EU,
keeps everything on a persistent volume, and starts locked to you.

[Deploy it on velixir](https://velixir.net/new?template=anythingllm), open the deploy log for your
password, sign in and pick a model.

## What you get

- **AnythingLLM 1.18.0**, built from the pinned upstream release: workspaces, document chat with
  citations, agents, an embeddable chat widget and the developer API.
- **Your data kept safe.** The template adds a persistent volume and keeps AnythingLLM's storage
  there: its database, your documents, the vector database, downloaded models and its settings. It
  all survives restarts and redeploys, and snapshots are taken daily and can be restored from the
  app's Volume tab.
- **Indexing that stays in the app.** Documents are turned into embeddings by a small model running
  inside AnythingLLM (downloaded once, onto the volume), and the vectors are stored next to them, so
  nothing is sent to a third party just to be indexed. Only your questions and the passages that
  answer them go to the model provider you pick.
- **Locked from the first start.** A fresh AnythingLLM is open to whoever finds it until someone
  sets a password. Here the first start sets one and prints it once to the deploy log.
- **Any model.** OpenAI, Anthropic, Mistral, Gemini, OpenRouter, Groq, DeepSeek, xAI, Azure,
  Bedrock, any OpenAI-compatible API and many more.
- **No usage statistics** are sent to AnythingLLM's makers unless you turn them on.

## Getting started

1. **Deploy it.** It takes a few minutes to build and about ten seconds to start.
2. **Find your password.** Open the app's log and find the box that begins
   **AnythingLLM is ready**. It is printed once.
3. **Sign in** at your app's address.
4. **Pick a model**: open **Settings**, then
   **AI Providers > LLM**, choose your provider and paste its API key. Keys are kept in
   AnythingLLM's settings on the volume.
5. **Create a workspace**, drop in some documents, and ask away.

To change the password, or to give several people their own accounts, go to
**Settings > Security** (multi-user mode adds an admin account and users, with
permissions per workspace).

| Variable | Required | What it does |
| --- | --- | --- |
| `ANYTHINGLLM_PASSWORD` | no | Sets the instance password on every start (single-user mode). The way back in if you lose it; remove it afterwards to manage the password in AnythingLLM. |
| `DISABLE_TELEMETRY` | no | `false` to send AnythingLLM's makers anonymous usage statistics. Off unless you set it. |

You can also set AnythingLLM's own variables on the Environment tab instead of using its settings
screens, for example `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL_PREF`.
The names are in upstream's
[`.env.example`](https://github.com/Mintplex-Labs/anything-llm/blob/master/docker/.env.example).
A variable set there is applied again on every start, over any change made in the app.

## Things to know

**You bring the model.** AnythingLLM does not include a chat model. Your provider bills the tokens
for every question, so set a spending limit with them. A model server of your own must be
reachable over HTTPS on port 443.

**It needs a paid plan with 1 GB of memory.** In testing it idled at about 340 MB and reached about
810 MB while indexing a 1.7 MB document with the built-in embedder. Large libraries, big PDFs and
image text recognition need more; choose 2 GB if you will feed it a lot. Volumes come with paid
plans, and on the Free plan the app would sleep and start over empty, so this template rules Free
out.

**Without a volume, everything resets.** If you untick the volume, AnythingLLM still runs, but
workspaces, chats, documents, settings and the password start from scratch on every restart and
redeploy. The log says so on every start.

**Web pages are read without a browser.** Adding a website link or using the agent's web scraping
fetches the page over plain HTTP. That works for most articles and documentation, but pages that
only render with JavaScript come back empty or partial. There is no headless browser in this image.

**Audio and video files are not transcribed.** That needs ffmpeg, which this image leaves out to
stay small. Documents, spreadsheets, presentations, text, web pages and images (with text
recognition) all work.

**Web-only network access.** The app reaches the internet on ports 80 and 443 only. Model APIs,
web pages and data connectors over HTTPS work; email over SMTP and databases on other ports do not.

**One replica.** AnythingLLM keeps everything in SQLite and files on the volume, so it runs as one
copy.

**Health check:** `/api/ping` answers 200 once AnythingLLM is up. While it starts, `/healthz`
answers 200 and other pages show a short "starting" page.

## What this repo is

A thin wrapper, not a fork. `package.json` pins an AnythingLLM release, and:

- `build-anythingllm.js` runs during the build. It downloads the tagged source from GitHub and
  builds it the way upstream's Dockerfile does: the web interface with Vite, the server and the
  document collector with their production dependencies from upstream's yarn lockfiles, and the
  Prisma client. It all ends up in `./anythingllm`.
- `start.js` runs the server and the collector, translating what velixir provides:

| velixir provides | AnythingLLM gets |
| --- | --- |
| `PORT` | `SERVER_PORT`; the collector gets a private port |
| `VELIXIR_VOLUME_PATH` | `server/storage` and `server/.env` linked to the volume (or the container disk, with a warning) |
| nothing | a password and session secret on the first start, migrations before start, telemetry off, both processes stopped together |

`nixpacks.toml` keeps the builder from adding a browser, adds the one library the server's chart
renderer needs, and starts `node start.js` directly, so the stop signal on a redeploy reaches
both processes.

To upgrade AnythingLLM, change its version in `package.json` and deploy. Read the
[release notes](https://github.com/Mintplex-Labs/anything-llm/releases) first, and take a volume
snapshot before you do. Upstream supports running it outside Docker only on a best-effort basis,
so test an upgrade before relying on it.

## Running it locally

```bash
npm run build
npm start
```

Then open http://localhost:3001 and sign in with the password printed in the terminal. It needs
Node 22 or newer and a few gigabytes of disk for the build. Data goes in `.anythingllm-data/` in
this folder.

## Upstream

AnythingLLM is MIT-licensed open source by Mintplex Labs. This wrapper is MIT too.

- Docs: https://docs.anythingllm.com
- Source: https://github.com/Mintplex-Labs/anything-llm
