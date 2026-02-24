"""
main.py
FastAPI entry point. Parses CLI args, initializes LightRAG, starts uvicorn.

Usage (dev):
    python main.py --vault-path /path/to/vault --openai-key sk-...

Usage (binary after PyInstaller build):
    ./obsidian-rag-backend --vault-path /path/to/vault --openai-key sk-...
"""

import argparse
import os
import sys
from contextlib import asynccontextmanager
from typing import Optional

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from rag_engine import RagEngine


def get_resource_path(relative: str) -> str:
    """Resolve path to bundled resources — works in both dev and PyInstaller onefile."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, relative)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Obsidian RAG backend server")
    parser.add_argument("--vault-path", required=True, help="Absolute path to the Obsidian vault root")
    parser.add_argument("--openai-key", required=True, help="OpenAI API key")
    parser.add_argument("--llm-model", default="gpt-4o-mini", help="OpenAI model ID (e.g. gpt-4o-mini, gpt-4o)")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args()


# Module-level engine singleton — referenced by routes.py
engine: Optional[RagEngine] = None

_args = parse_args()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    storage_dir = os.path.join(_args.vault_path, ".obsidian-rag")
    os.makedirs(storage_dir, exist_ok=True)

    engine = RagEngine(storage_dir=storage_dir, args=_args)
    await engine.initialize()
    print(f"[obsidian-rag] Engine ready. Storage: {storage_dir}", flush=True)

    yield

    print("[obsidian-rag] Shutting down.", flush=True)


app = FastAPI(title="Obsidian RAG Backend", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

from routes import router  # noqa: E402
app.include_router(router)


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=_args.port,
        log_level="warning",
        reload=False,
    )
