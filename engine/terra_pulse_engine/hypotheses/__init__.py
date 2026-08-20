from terra_pulse_engine.api.contracts import (
    AntipodalRunRequest,
    DiscreteTriggerRunRequest,
    HemisphereRunRequest,
    LagWindowRunRequest,
)
from terra_pulse_engine.hypotheses.h1b import run_h1b
from terra_pulse_engine.hypotheses.h5 import run_h5
from terra_pulse_engine.hypotheses.h2b import run_h2b
from terra_pulse_engine.hypotheses.h3b import run_h3b
from terra_pulse_engine.hypotheses.h4c import run_h4c

# The registry GET /v1/hypotheses reports from, and (via `request_model`)
# what api/main.py validates an incoming request against before dispatching
# — see that module's note on why hypothesis families with genuinely
# different parameter shapes (H2b has no baseline window at all) get their
# own request model rather than one shared, increasingly-optional shape.
REGISTRY = {
    "H4c": {
        "run": run_h4c,
        "tests_in_family": 6,
        "implemented": True,
        "request_model": LagWindowRunRequest,
    },
    "H3b": {
        "run": run_h3b,
        "tests_in_family": 4,
        "implemented": True,
        "request_model": LagWindowRunRequest,
    },
    "H2b": {
        "run": run_h2b,
        "tests_in_family": 2,
        "implemented": True,
        "request_model": HemisphereRunRequest,
    },
    "H1b": {
        "run": run_h1b,
        "tests_in_family": 4,
        "implemented": True,
        "request_model": DiscreteTriggerRunRequest,
    },
    "H5": {
        "run": run_h5,
        "tests_in_family": 1,
        "implemented": True,
        "request_model": AntipodalRunRequest,
    },
}
