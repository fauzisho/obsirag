# build.spec — PyInstaller spec for obsirag-backend
# Run with: pyinstaller build.spec --noconfirm --clean
# Output:   dist/obsirag-backend  (single file, ~80-150MB with UPX)

import sys
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_all

block_cipher = None

# ── Data files needed at runtime ───────────────────────────────────────────
datas = []
binaries = []

# numpy: must use collect_all to include C extensions (.so/.pyd)
# collect_all returns (datas, binaries, hiddenimports)
numpy_datas, numpy_binaries, numpy_hidden = collect_all("numpy")
datas    += numpy_datas
binaries += numpy_binaries

datas += collect_data_files("lightrag")        # prompt templates, configs
datas += collect_data_files("tiktoken_ext")    # BPE encoding files
datas += collect_data_files("tiktoken")

# ── Hidden imports (dynamic loading that PyInstaller misses) ───────────────
hidden_imports = [
    # uvicorn internals
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    # fastapi / starlette
    "starlette.routing",
    "starlette.middleware",
    "starlette.middleware.cors",
    "starlette.background",
    # pydantic v2
    "pydantic.deprecated.class_validators",
    "pydantic_core",
    # lightrag storage backends (all loaded dynamically via string names)
    "lightrag.kg.nano_vector_db_impl",
    "lightrag.kg.json_kv_impl",
    "lightrag.kg.networkx_impl",
    "lightrag.llm.openai",
    # document parsing
    "fitz",
    "fitz.utils",
    "docx",
    "docx.oxml",
    "docx.oxml.ns",
    "openpyxl",
    "openpyxl.styles",
    "openpyxl.styles.stylesheet",
    "openpyxl.cell",
    "pytesseract",
    "PIL",
    "PIL.Image",
    "PIL._imagingtk",
    # llm / http clients
    "openai",
    "openai.resources",
    "httpx",
    "httpcore",
    "anyio",
    "anyio._backends._asyncio",
    "anyio._backends._trio",
    # misc runtime deps
    "multipart",
    "h11",
    "certifi",
    "charset_normalizer",
    "tiktoken",
    "tiktoken_ext.openai_public",
    "networkx",
    "numpy",
    "pipmaster",
] + numpy_hidden

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=["hooks/rthook_pipmaster.py"],
    excludes=[
        # GUI toolkits never needed
        "tkinter", "_tkinter", "tk", "tcl",
        "PyQt5", "PyQt6", "PySide2", "PySide6", "wx",
        # Heavy unused scientific stack
        "matplotlib", "scipy", "sklearn", "pandas",
        "IPython", "jupyter", "notebook", "nbformat",
        # Test frameworks
        "pytest", "unittest",
        # Build tools
        "setuptools", "pip",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="obsirag-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,    # strip debug symbols on Linux/macOS (~15-20% smaller)
    upx=True,      # UPX compression (~30-40% smaller, ~0.5s extra startup once)
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # keep console output for debugging; set False for silent mode
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,  # fill in for macOS Developer ID signing
    entitlements_file=None,
    onefile=True,
)
