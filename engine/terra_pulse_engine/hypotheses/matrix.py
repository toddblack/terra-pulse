"""Where the registered test matrix stands, for every hypothesis module.

This is one fact about the whole matrix, not a parameter of any hypothesis, so
it lives in one place. Each module used to carry its own copy, and when H6
shipped (2026-08-26) and completed the matrix only `h6.py`'s copy was updated:
the other five kept telling every result that two tests were "deferred to
Phase 5" and that adjusted p-values were provisional, for weeks after neither
was true.

The hypothesis modules still never import from each other — a registered
parameter must not be shared by accident — but they all read this.
"""

from __future__ import annotations

# Nothing is deferred: H6's two tests, the last pair waiting on Phase 5, ran on
# 2026-08-26. Nothing is blocked either: H4b was withdrawn unrun on 2026-08-20,
# and a withdrawn family leaves the matrix rather than waiting in it (see
# HYPOTHESES.md H4b and REGISTERED_MATRIX_TESTS in packages/schema).
DEFERRED_TESTS = 0
BLOCKED_TESTS = 0


def correction_note(tests_run: int, registered_matrix_tests: int) -> str:
    """The sentence shown under every result's table.

    A run computes only its own hypothesis's tests, so it always reports two
    adjustments: within the run, and against the full registered matrix. The
    second puts every registered test in the Benjamini-Hochberg denominator,
    which can only make an adjusted value larger — hence "conservative".
    """
    was = "test was" if tests_run == 1 else "tests were"
    return (
        f"{tests_run} of {registered_matrix_tests} registered {was} run in this "
        "session. Adjusted p-values are reported both within this run and against "
        "the full registered matrix; the full-matrix figure is the conservative one."
    )
