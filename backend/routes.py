"""
routes.py
FastAPI route handlers. Imports main.engine at call time to avoid circular imports.
"""

import asyncio
import os
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from document_parser import parse_document
from rag_engine import indexing_status

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class IndexRequest(BaseModel):
    paths: list[str]
    vault_path: str


class QueryRequest(BaseModel):
    question: str
    mode: Literal["hybrid", "local", "global", "naive"] = "hybrid"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/health")
async def health() -> dict:
    import main  # late import avoids circular ref at module load
    return {
        "status": "ok",
        "engine_ready": main.engine is not None and main.engine.rag is not None,
    }


@router.post("/index")
async def index_documents(req: IndexRequest, background_tasks: BackgroundTasks) -> dict:
    if not req.paths:
        raise HTTPException(400, "No paths provided")
    background_tasks.add_task(_index_worker, req.paths, req.vault_path)
    return {"message": "indexing started", "count": len(req.paths)}


async def _index_worker(paths: list[str], vault_path: str) -> None:
    import main

    indexing_status["running"] = True
    indexing_status["total"] = len(paths)
    indexing_status["indexed"] = 0
    indexing_status["errors"] = []

    for path in paths:
        indexing_status["current_file"] = path
        try:
            text = await asyncio.to_thread(parse_document, path)
            if text:
                # Store relative path so the plugin can open the note
                rel_path = os.path.relpath(path, vault_path) if vault_path else path
                await main.engine.insert_document(text, rel_path)
        except Exception as exc:
            indexing_status["errors"].append({"file": path, "error": str(exc)})
        finally:
            indexing_status["indexed"] += 1

    indexing_status["running"] = False
    indexing_status["current_file"] = ""


@router.get("/index/status")
async def index_status() -> dict:
    return indexing_status


@router.post("/query")
async def query_rag(req: QueryRequest) -> dict:
    import main
    if main.engine is None or main.engine.rag is None:
        raise HTTPException(503, "Engine not initialized — wait for /health to return engine_ready: true")
    if indexing_status["running"]:
        raise HTTPException(503, "Indexing in progress — please wait")
    try:
        answer, sources = await main.engine.query_with_sources(req.question, req.mode)
    except Exception as exc:
        raise HTTPException(502, f"LLM query failed: {exc}. Try POST /reconnect to refresh the engine.")
    if not answer:
        raise HTTPException(502, "LLM returned empty answer — OpenAI connection may be stale (e.g. after sleep). Try POST /reconnect.")
    return {"answer": answer, "mode": req.mode, "sources": sources}


@router.post("/reconnect")
async def reconnect_engine() -> dict:
    """Reinitialize the LightRAG engine to refresh broken HTTP sessions (e.g. after laptop sleep/wake)."""
    import main
    if main.engine is None:
        raise HTTPException(503, "Engine not initialized")
    await main.engine.initialize()
    return {"message": "engine reinitialized"}


@router.delete("/index")
async def clear_index() -> dict:
    import main
    import shutil
    import os

    storage = main.engine.storage_dir
    for item in os.listdir(storage):
        if item == "bin":
            continue  # never delete the downloaded binary
        p = os.path.join(storage, item)
        if os.path.isdir(p):
            shutil.rmtree(p)
        else:
            os.remove(p)

    # Re-initialize a fresh engine with the same args
    await main.engine.initialize()
    return {"message": "index cleared"}
