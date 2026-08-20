# Terra Pulse statistical engine

The Phase 4 Python service: pre-registered hypothesis testing per
`HYPOTHESES.md`, run locally, spoken to over HTTP by Electron main
(`apps/desktop/src/main/ipc/analysis.ts`). Dev-only this round — see
`PROJECT_PLAN.md` §10 for the deferred PyInstaller/bundling decision.

This package lives outside the pnpm workspace on purpose
(`pnpm-workspace.yaml` only globs `apps/*` and `packages/*`), so `pnpm -r
test`/`typecheck` never touch it — that would break the TypeScript suite for
anyone without Python installed, which is the opposite of this app's
degrade-quietly posture toward optional prerequisites.

## Prerequisite

Python 3.12.x. Nothing else needs to be installed system-wide — everything
else lives in this package's own venv.

## Setup

```
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"     # Windows
.venv/bin/python -m pip install -e ".[dev]"              # macOS/Linux
```

## Run

```
.venv\Scripts\python.exe -m terra_pulse_engine --port 8787
```

Electron main **adopts** an already-running engine on `127.0.0.1:8787` if it
finds one healthy at startup — which is what the command above gives you —
rather than spawning its own. This is the normal dev loop: run the engine
yourself (optionally with `uvicorn terra_pulse_engine.api.main:app --reload`
for autoreload during development), then start the desktop app normally. If
nothing answers on that port, main spawns the engine itself instead;
see `apps/desktop/src/main/ipc/analysis.ts` for the exact adopt-or-spawn
logic and the `TERRA_PULSE_PYTHON` / `TERRA_PULSE_ENGINE_PORT` overrides it
reads.

`GET /health` is the quickest way to check it's up:

```
curl http://127.0.0.1:8787/health
```

## Test

```
.venv\Scripts\python.exe -m pytest
```

`tests/fixtures/gk_parity.json` and `tests/fixtures/analysis_response_v1.json`
are shared with the TypeScript side (`packages/schema/src/recurrence.test.ts`
and the analysis contract tests respectively) — if a change here makes one of
those fixtures stop matching, the corresponding TS test is the other half of
that signal, not a false alarm to silence on this side alone.

## Package layout

- `api/` — FastAPI app, request/response contracts (Pydantic, hand-written —
  see `contracts.py`'s docstring for why this isn't generated), typed error
  envelope.
- `pipeline/` — hypothesis-agnostic statistics: declustering, threshold
  episode extraction, the moving-window Poisson baseline, the lag-window
  test statistic, chunked Monte Carlo permutation, Benjamini-Hochberg FDR.
  None of these modules know what a hypothesis id is.
- `hypotheses/` — one module per implemented hypothesis, assembling the
  `pipeline/` pieces for that hypothesis's exact registered parameters.
  `h4c.py`, `h3b.py`, `h2b.py`, `h1b.py`, `h5.py`. Adding a hypothesis means
  adding a module here and a registry entry in `hypotheses/__init__.py` — it
  should not require touching `pipeline/` unless the new hypothesis needs a
  genuinely new kind of statistic. Four of the five needed nothing new; **H5
  did**, and `pipeline/ks.py` is what that looks like: a supremum-of-CDF-
  difference is not a rate ratio by any amount of parameter reuse.

## Known follow-ups (not this round)

- PyInstaller/bundling, so a packaged Terra Pulse build doesn't need a
  system Python at all.
- ~~The magnitude-of-completeness map H5 needs.~~ **Not needed.** H5 shipped
  2026-08-20 on a null that conditions on the detected catalogue instead of
  weighting by an estimated Mc — see `hypotheses/h5.py`'s module docstring and
  HYPOTHESES.md H5. Any *future* spatial test still has to satisfy the
  completeness requirement one way or the other.
- **Vectorizing `hypotheses/h4c.py`'s permutation `statistic_fn` across the
  batch dimension.** Measured against the real dev database (92,106 raw
  M5.0+ events, 48,371 declustered, 496,423 space-weather hours 1970+): a
  full H4c run (6 tests × 10,000 permutations) takes **~30 seconds**, not
  the "seconds" this round's plan estimated — the per-permutation-row Python
  loop is the cost, not declustering (which is fast, well under a second).
  Comfortably inside the single-POST design's 120 s IPC timeout, so this
  isn't a correctness problem, but it's the first place to optimize if a
  future hypothesis's data volume pushes it further. End-to-end verified
  this round: trigger counts (1,149 Kp≥6 episodes, 511 Dst≤−100 episodes)
  match an independent SQL/JS recomputation exactly, and the expected daily
  rate (~2.31/day) matches the catalogue's own global declustered rate
  (~2.37/day) to within a few percent.

  **H1b's data volume did push it further, and `hypotheses/h1b.py` shows what
  to do about it.** At 4,598 triggers (4x H4c's largest) the per-row loop
  measured 102 s, and batch-vectorizing it across the permutation dimension
  did *not* fix that — it removes numpy call overhead, not the underlying
  work. What fixed it: both quantities the null needs (the local baseline
  rate, and the lag-window count) are **pure functions of the trigger
  instant**, and the null draws from a fixed hourly pool — so both are
  evaluated once per eligible hour and read by index. **102 s → 12.2 s,
  bit-identical results.** Prefer that shape over vectorizing the loop; see
  `tests/test_h1b.py` for the exact-equality oracle it is pinned against.
