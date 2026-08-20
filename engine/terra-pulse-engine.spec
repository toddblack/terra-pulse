# PyInstaller spec for the statistical engine.
#
# Built so a packaged Terra Pulse needs no system Python at all
# (PROJECT_PLAN.md §10). The desktop app ships the resulting folder as an
# electron-builder `extraResource` and spawns the executable instead of an
# interpreter; see `resolveEngineCommand` in
# `apps/desktop/src/main/ipc/analysis.ts`.
#
# ## One-folder, not one-file, and that is load-bearing
#
# `--onefile` looks tidier and is the wrong choice here. A one-file build is a
# self-extracting archive: every launch unpacks the whole of numpy and scipy to
# a temp directory before the first line of Python runs. That is seconds of
# startup on every spawn, it is repeated on every launch rather than paid once,
# and antivirus software treats "executable writes a pile of DLLs to temp and
# runs them" as exactly what it is trained to flag. One-folder starts in
# roughly the time the interpreter itself takes and touches nothing outside its
# own directory.
#
# ## Why the hidden imports are needed
#
# PyInstaller finds dependencies by following `import` statements statically.
# Uvicorn chooses its event loop, HTTP protocol and lifespan implementations at
# *runtime* by importing a string name, so nothing in the source graph points at
# them and the analyser cannot see them. Frozen without these the binary builds
# cleanly and then dies on startup with a bare `ModuleNotFoundError`, which is
# why they are listed explicitly rather than discovered.

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = [
    # Chosen at runtime by uvicorn's auto-detection, so invisible to static analysis.
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    # The app is referenced by import string from __main__, not by an import.
    "terra_pulse_engine.api.main",
]

# Every hypothesis module is reached through the registry's own lookup rather
# than a direct import, so add the package wholesale: a hypothesis that fails to
# freeze would otherwise only be discovered by a user running that one test.
hiddenimports += collect_submodules("terra_pulse_engine")

analysis = Analysis(
    ["terra_pulse_engine/__main__.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Test-only and packaging-only dependencies. Excluding them is not
    # micro-optimisation: matplotlib and tkinter alone are tens of megabytes,
    # and this binary is shipped inside an installer.
    excludes=[
        "pytest",
        "httpx",
        "ruff",
        "matplotlib",
        "tkinter",
        "PIL",
        "IPython",
        "notebook",
        "pandas",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="terra-pulse-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # No console window. Electron spawns this with piped stdio and already
    # passes `windowsHide`; a visible terminal appearing behind the app on every
    # launch would look like a fault.
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

collect = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="terra-pulse-engine",
)
