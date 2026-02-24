# ObsiRAG — DevOps Lifecycle

End-to-end guide: local development → testing → release → production.

---

## Overview

```
Edit code
   │
   ▼
Build plugin (npm)  ──────────────────────────────┐
   │                                               │
   ▼                                               │
Rebuild binary (PyInstaller, if backend changed)   │
   │                                               │
   ▼                                               │
Replace binary in vault & reload plugin            │
   │                                               │
   ▼                                               │
Test in Obsidian ◄──────── iterate if bugs ────────┘
   │
   ▼  satisfied
git commit && git push
   │
   ▼
Bump version in manifest.json + package.json
   │
   ▼
git tag vX.Y.Z && git push origin vX.Y.Z
   │
   ▼
GitHub Actions builds 3 binaries + GitHub Release
   │
   ▼
Delete local binary → Disable/Enable plugin
→ Download modal → downloads from Release
→ Production test ✓
```

---

## Phase 1 — Local Development

### 1.1 Edit & build the plugin (TypeScript changes)

```bash
cd plugin
npm run build
# Outputs: plugin/main.js + plugin/styles.css
```

Then in Obsidian: **Settings → Community plugins → ObsiRAG → Disable → Enable**

> No binary rebuild needed for TypeScript-only changes.

### 1.2 Test Python backend changes without rebuilding binary

For rapid iteration on `backend/*.py`, skip PyInstaller and run from source:

```bash
# Kill any running backend first
pkill -f "obsirag-backend-macos" 2>/dev/null || true

cd backend
source ../.venv/bin/activate
python main.py \
  --vault-path "/path/to/your/vault" \
  --openai-key "sk-..." \
  --port 8765
```

The plugin detects the running backend and adopts it automatically.

### 1.3 Rebuild the binary (backend changes ready for full test)

Only needed when you want to test the full production flow locally, or when Python changes are final.

```bash
cd backend
source ../.venv/bin/activate
pyinstaller build.spec --noconfirm
# Output: backend/dist/obsirag-backend  (macOS)
```

Replace the binary the plugin uses:

```bash
cp "backend/dist/obsirag-backend" \
   "<vault>/.obsirag/bin/obsirag-backend-macos"

# Remove Gatekeeper quarantine (macOS)
xattr -d com.apple.quarantine \
   "<vault>/.obsirag/bin/obsirag-backend-macos" 2>/dev/null || true
```

Then **Disable → Enable** the plugin in Obsidian to spawn the new binary.

### 1.4 Verify endpoints

```bash
curl -s http://localhost:8765/health
# {"status":"ok","engine_ready":true}

curl -s http://localhost:8765/graph
# {"nodes":[...],"edges":[...],"stats":{...}}

curl -s http://localhost:8765/index/status
# {"total":0,"indexed":0,"running":false,"errors":[]}
```

---

## Phase 2 — Commit & Push

```bash
# Build plugin to ensure main.js is current
cd plugin && npm run build && cd ..

# Stage only source files (main.js is gitignored)
git add backend/ plugin/src/ plugin/styles.css manifest.json

git commit -m "feat: description of changes"
git push origin main
```

---

## Phase 3 — Create a Release

### 3.1 Bump version

Edit **both** files to match (e.g. `0.1.0` → `0.2.0`):

- `plugin/manifest.json` → `"version": "0.2.0"`
- `plugin/package.json`  → `"version": "0.2.0"`

```bash
git add plugin/manifest.json plugin/package.json
git commit -m "chore: bump version to 0.2.0"
git push origin main
```

### 3.2 Tag & trigger CI

```bash
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions (`.github/workflows/build-binaries.yml`) automatically:

1. Builds on `ubuntu-22.04`, `windows-2022`, `macos-13`
2. Produces:
   - `obsirag-backend-macos`
   - `obsirag-backend-windows.exe`
   - `obsirag-backend-linux`
3. Generates `.sha256` checksum files for each binary
4. Creates a GitHub Release at the tag and uploads all assets

Monitor progress at: `https://github.com/fauzisho/obsirag/actions`

---

## Phase 4 — Production Test (simulate fresh install)

### 4.1 Remove the local binary

```bash
rm "<vault>/.obsirag/bin/obsirag-backend-macos"
```

### 4.2 Reload the plugin

In Obsidian: **Disable → Enable ObsiRAG**

The plugin detects the missing binary and shows the **Download modal**.

### 4.3 Download & verify

1. Click **OK** in the download modal
2. Plugin downloads the binary from the GitHub Release
3. SHA-256 checksum is verified automatically
4. Binary is marked executable and quarantine attribute removed
5. Notice: **"RAG: backend ready."**

### 4.4 Smoke test

| Test | Expected |
|------|----------|
| `curl /health` | `engine_ready: true` |
| Index current file | Status bar shows `1/1`, then success notice |
| Chat question | Answer returned with source links |
| RAG Graph view | Nodes and edges rendered |

---

## Quick Reference

| Scenario | Steps |
|----------|-------|
| TypeScript only changed | `npm run build` → Reload plugin |
| Python only changed (iterating) | Kill binary → `python main.py` → test |
| Python changed (final) | `pyinstaller build.spec` → copy binary → Reload plugin |
| Ready to ship | Bump version → commit → `git tag` → `git push --tags` |
| Test production download | Delete binary → Disable/Enable plugin |
| Backend stuck / stale session | Command palette → `ObsiRAG: Reconnect RAG engine` |

---

## File Reference

| File | Role |
|------|------|
| `backend/main.py` | FastAPI entry point, CLI args, uvicorn |
| `backend/rag_engine.py` | LightRAG init, query, source extraction |
| `backend/routes.py` | All API endpoints (`/health` `/index` `/query` `/graph`) |
| `backend/document_parser.py` | MD / PDF / DOCX / XLSX / image parsers |
| `backend/build.spec` | PyInstaller spec — add to `hiddenimports` if build fails |
| `plugin/src/main.ts` | Plugin entry, view registration, lifecycle |
| `plugin/src/backend-manager.ts` | Binary download, process spawn/kill, health monitor |
| `plugin/src/rag-client.ts` | HTTP client for all backend calls |
| `plugin/src/commands.ts` | Index commands (file / folder / vault / clear) |
| `plugin/src/views/chat-view.ts` | Sidebar chat UI with source hyperlinks |
| `plugin/src/views/graph-view.ts` | Canvas force-directed knowledge graph view |
| `plugin/styles.css` | All plugin styles (chat + graph) |
| `.github/workflows/build-binaries.yml` | CI — multi-platform binary builds on tag push |
