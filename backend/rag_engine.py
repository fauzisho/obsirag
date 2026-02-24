"""
rag_engine.py
LightRAG engine using OpenAI API for LLM and embeddings.
Compatible with lightrag-hku >= 1.4.x
"""

import functools
import os
import re
from typing import Any

from lightrag import LightRAG, QueryParam
from lightrag.llm.openai import openai_complete_if_cache, openai_embed as _openai_embed_func
from lightrag.utils import EmbeddingFunc

# Marker embedded into each document to track its source path
_SOURCE_PREFIX = "[SOURCE_FILE: "
_SOURCE_SUFFIX = "]"
_SOURCE_PATTERN = re.compile(r"\[SOURCE_FILE: (.+?)\]")


# Shared indexing progress state (read by routes.py /index/status endpoint)
indexing_status: dict[str, Any] = {
    "total": 0,
    "indexed": 0,
    "current_file": "",
    "running": False,
    "errors": [],
}


class RagEngine:
    def __init__(self, storage_dir: str, args: Any) -> None:
        self.storage_dir = storage_dir
        self.args = args
        self.rag: LightRAG | None = None

    async def initialize(self) -> None:
        os.makedirs(self.storage_dir, exist_ok=True)
        os.environ["OPENAI_API_KEY"] = self.args.openai_key

        model_name = self.args.llm_model
        api_key = self.args.openai_key

        # LightRAG calls llm_model_func(prompt, system_prompt=..., history_messages=..., **kwargs)
        # openai_complete_if_cache expects (model, prompt, ...) so we wrap it
        async def llm_func(prompt, system_prompt=None, history_messages=None, **kwargs):
            kwargs.pop("keyword_extraction", None)  # handled internally by lightrag
            return await openai_complete_if_cache(
                model_name,
                prompt,
                system_prompt=system_prompt,
                history_messages=history_messages or [],
                api_key=api_key,
                **kwargs,
            )

        embedding_func = EmbeddingFunc(
            embedding_dim=1536,  # text-embedding-3-small
            max_token_size=8192,
            func=functools.partial(
                _openai_embed_func.func,
                model="text-embedding-3-small",
                api_key=api_key,
            ),
        )

        self.rag = LightRAG(
            working_dir=self.storage_dir,
            llm_model_func=llm_func,
            llm_model_name=model_name,
            llm_model_max_async=4,
            embedding_func=embedding_func,
        )
        await self.rag.initialize_storages()

    async def insert_texts(self, texts: list[str]) -> None:
        if self.rag is None:
            raise RuntimeError("Engine not initialized")
        await self.rag.ainsert(texts)

    async def insert_document(self, text: str, file_path: str) -> None:
        """Insert a document with its source path embedded as a marker."""
        if self.rag is None:
            raise RuntimeError("Engine not initialized")
        marked = f"{_SOURCE_PREFIX}{file_path}{_SOURCE_SUFFIX}\n\n{text}"
        await self.rag.ainsert(marked)

    async def query(self, question: str, mode: str = "hybrid") -> str:
        if self.rag is None:
            raise RuntimeError("Engine not initialized")
        return await self.rag.aquery(
            question,
            param=QueryParam(mode=mode),
        )

    async def query_with_sources(self, question: str, mode: str = "hybrid") -> tuple[str, list[str]]:
        """Query and also return a deduplicated list of source file paths."""
        if self.rag is None:
            raise RuntimeError("Engine not initialized")

        answer = await self.rag.aquery(question, param=QueryParam(mode=mode))

        sources: list[str] = []
        try:
            # naive mode retrieves raw text chunks (not KG triples), so our
            # [SOURCE_FILE: ...] markers survive and can be parsed out.
            context = await self.rag.aquery(
                question,
                param=QueryParam(mode="naive", only_need_context=True),
            )
            if context:
                sources = list(dict.fromkeys(_SOURCE_PATTERN.findall(str(context))))
        except Exception:
            pass

        return answer, sources
