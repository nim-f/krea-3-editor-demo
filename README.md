# Krea Editor

A local image editor: open or generate an image, select the area you want to change, describe the edit, and keep iterating. Every result is a version you can step back through. Generation runs through either the **Krea API** or **OpenRouter**, switchable from the top bar.

Built for a YouTube video: https://youtu.be/7v5bwY43txg

## Quick start

```bash
npm install
cp .env.example .env   # then add a key (see below)
npm run dev            # web on http://localhost:5173, API on http://localhost:8787
```

For a production-style run (builds the frontend and serves it from the API server):

```bash
npm start              # http://localhost:8787
```

## Configuration

Set these in `.env`. Keys are re-read on every request, so you don't need to restart after changing them.

| Variable | Purpose |
| - | - |
| `KREA_API_TOKEN` | Krea API token (`KREA_API_KEY` also works). Create one at https://www.krea.ai/settings/api-tokens |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `KREA_API_BASE` | Optional. Default `https://api.krea.ai` |
| `KREA_MODEL_PATH` | Optional. Default `/generate/image/krea/krea-3` |
| `OPENROUTER_API_BASE` | Optional. Default `https://openrouter.ai/api/v1` |
| `OPENROUTER_MODEL` | Optional. Default `krea/k3-edit` |
| `PORT` | Optional. API port, default `8787` |

You only need a key for the provider you use. If the selected provider has no key, a banner tells you which variable to set.

## Providers

Use the **Krea / OpenRouter** toggle in the top bar. Your choice is remembered in the browser.

- **Krea**: calls the Krea API directly. Jobs are asynchronous (create, poll, download); cancelling in the UI also cancels the Krea job. The model list is Krea 3 only (1K/2K, 10 aspect ratios, seed, up to 8 reference images). Krea 3 is in early access, so your workspace must be enabled for it.
- **OpenRouter**: lists every image-output model OpenRouter offers, with each model's supported resolutions, aspect ratios, seed and reference limits.

## Using the editor

- **Open / generate**: drop an image on the canvas or click *Open image*, or just type a prompt to generate from scratch.
- **Select an area**: rectangle (▭) or brush (✎). The edit is applied to the selected area and, with *Lock outside selection* on, pasted back through the selection so nothing else changes.
- **Edit selections**: eraser (⌫) removes parts, the ⊗ tool or the **×** button on a selection deletes that whole selection, ✕ clears everything.
- **Edit**: write what should change and press **⌘/Ctrl+Enter**. Add reference images and a negative prompt in the side panel. The camera panel generates alternate camera angles.
- **Versions**: each result is added to the filmstrip. *Hold to compare* shows the original. **⌘/Ctrl+Z** undoes selection changes first, then steps back through versions; **⌘/Ctrl+Shift+Z** redoes.
- **Pan and zoom**: hold Space or use the hand tool; scroll to zoom.
- **History**: every generation is saved to `data/` (`history.json` plus `data/images/`). Open the *History* drawer to reopen or download past results.

## Project layout

```
server/index.js        Express API: provider layer (OpenRouter + Krea), saved history
src/App.jsx            App state, prompt building, provider/model selection
src/api.js             Client for the local API
src/components/        Stage (canvas, selection), CameraPanel, Gallery
src/imageUtils.js      Image loading, mask and guide-image helpers
data/                  Saved generations (local, created at runtime)
```

### API

| Endpoint | Description |
| - | - |
| `GET /api/status` | Per-provider key status and default model |
| `GET /api/models?provider=` | Models for a provider |
| `POST /api/generate` | Generate or edit; body includes `provider`. Returns `{ image, usage }` for both providers |
| `GET/POST/DELETE /api/history` | Saved generations |

The server only binds to `127.0.0.1`. Keep API keys on the server; they are never sent to the browser.
