# ObsiRAG

An Obsidian plugin that brings RAG-Anything-level retrieval to your vault.
Uses **LightRAG** (knowledge graph + hybrid vector retrieval) with a Python backend packaged as a **single auto-downloaded binary** — no Python installation required.

## Features

- Chat with your entire vault using a sidebar panel
- Supports **Markdown, PDF, DOCX, XLSX, images (OCR)**
- Knowledge graph + hybrid retrieval (LightRAG)
- **OpenAI** (API key required)
- Index current file, current folder, or entire vault
- Storage inside your vault at `.obsidian-rag/`

## Install

1. Copy `plugin/` contents to `<vault>/.obsidian/plugins/obsidian-rag/`
2. Enable plugin in Obsidian → Settings → Community Plugins
3. On first launch a download modal appears — click OK to download the ~100MB backend binary (one time only)
4. Configure your LLM provider in Settings → Obsidian RAG

## Development

### Backend

```bash
cd backend
pip install -r requirements.txt

```

### Plugin

```bash
cd plugin
npm install
npm run dev        # watch mode
npm run build      # production build → main.js
```

Copy `main.js` + `manifest.json` to `<vault>/.obsidian/plugins/obsidian-rag/`.

### Build Binary

```bash
cd backend
pip install pyinstaller
pyinstaller build.spec --noconfirm --clean
# Output: backend/dist/obsidian-rag-backend
```

### Release (CI)

Push a semver tag to trigger multi-platform builds:

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions builds Linux / macOS / Windows binaries and creates a GitHub Release automatically.

## Architecture

```
Obsidian Plugin (TypeScript)
        ↕ HTTP localhost:8765
FastAPI Server (Python binary, auto-downloaded)
  ├── LightRAG  — knowledge graph + hybrid retrieval
  ├── PyMuPDF   — PDF parsing
  ├── python-docx / openpyxl — Office parsing
  ├── pytesseract — image OCR (requires Tesseract installed)
  └── Storage: .obsidian-rag/ inside vault
```

## Important Files

| File | Purpose |
|------|---------|
| `backend/main.py` | FastAPI entry point, CLI args, uvicorn |
| `backend/rag_engine.py` | LightRAG setup, OpenAI  |
| `backend/document_parser.py` | Multi-format document parsing |
| `backend/routes.py` | API route handlers |
| `backend/build.spec` | PyInstaller spec (edit hidden_imports if build fails) |
| `plugin/src/main.ts` | Plugin entry point |
| `plugin/src/backend-manager.ts` | Binary download, process management |
| `plugin/src/rag-client.ts` | HTTP client for backend API |
| `plugin/src/views/chat-view.ts` | Sidebar chat UI |

## Troubleshooting

**Backend won't start** — check console (Ctrl+Shift+I in Obsidian) for errors from the backend process.

**"Port 8765 in use"** — change `backendPort` in plugin settings.

**PyInstaller build fails with ImportError** — add the missing module to `hiddenimports` in `build.spec`.

**Images not indexing** — install Tesseract: `brew install tesseract` (macOS) or `apt install tesseract-ocr` (Linux).

**macOS "binary is damaged"** — the plugin handles this automatically via `xattr -d com.apple.quarantine` after download.
