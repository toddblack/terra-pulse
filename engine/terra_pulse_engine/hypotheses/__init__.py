from terra_pulse_engine.hypotheses.h4c import run_h4c

# The registry GET /v1/hypotheses reports from. Adding a second hypothesis
# means adding a second entry here — nothing else in api/main.py should need
# to change.
REGISTRY = {
    "H4c": {"run": run_h4c, "tests_in_family": 6, "implemented": True},
}
