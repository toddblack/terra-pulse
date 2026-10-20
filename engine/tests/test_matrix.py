"""The registered matrix's status is defined once, in hypotheses/matrix.py.

Every hypothesis module used to carry its own copy of DEFERRED_TESTS and its
own note, and five of six went stale when H6 completed the matrix — every
Analyze result went on saying two tests were deferred to Phase 5. These tests
keep it from drifting back.
"""

from __future__ import annotations

import re
from pathlib import Path

from terra_pulse_engine.hypotheses import matrix
from terra_pulse_engine.hypotheses.matrix import correction_note

HYPOTHESES_DIR = Path(matrix.__file__).parent


def test_the_matrix_is_complete() -> None:
    assert matrix.DEFERRED_TESTS == 0
    assert matrix.BLOCKED_TESTS == 0


def test_no_hypothesis_module_keeps_its_own_copy() -> None:
    modules = sorted(p for p in HYPOTHESES_DIR.glob("h*.py"))
    assert len(modules) == 6, [p.name for p in modules]
    for path in modules:
        source = path.read_text(encoding="utf-8")
        assert not re.search(r"^(DEFERRED|BLOCKED)_TESTS\s*=", source, re.MULTILINE), path.name
        assert "correction_note(" in source, path.name


def test_note_wording() -> None:
    assert correction_note(6, 19) == (
        "6 of 19 registered tests were run in this session. Adjusted p-values are "
        "reported both within this run and against the full registered matrix; the "
        "full-matrix figure is the conservative one."
    )
    assert correction_note(1, 19).startswith("1 of 19 registered test was run")
    for note in (correction_note(1, 19), correction_note(6, 19)):
        assert "deferred" not in note
        assert "provisional" not in note
