# Runtime hook: disable pipmaster auto-install inside PyInstaller binary.
# LightRAG calls pm.is_installed() / pm.install() at import time.
# Inside the frozen bundle all packages are already present, so we
# replace pipmaster with a stub that always reports packages as installed.

import sys
from types import ModuleType

class _PipMasterStub(ModuleType):
    def is_installed(self, *args, **kwargs):
        return True

    def install(self, *args, **kwargs):
        return True

    def install_or_update(self, *args, **kwargs):
        return True

    def ensure(self, *args, **kwargs):
        return True

    def __getattr__(self, name):
        return lambda *a, **kw: True

stub = _PipMasterStub("pipmaster")
sys.modules["pipmaster"] = stub
