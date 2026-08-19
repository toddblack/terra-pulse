"""Request/response contracts for POST /v1/analysis/run.

Every parameter field is required — no defaults — by design: this is what
makes "no free parameters chosen after seeing results" (non-negotiable #3)
structural rather than a matter of discipline. A request that omits, say,
`baselineWindowDays` fails with 422 rather than quietly assuming a number
nobody registered in HYPOTHESES.md.

Hand-written rather than generated from packages/schema — this is one request
and one response shape, which doesn't justify standing up a JSON-Schema
codegen toolchain that doesn't exist anywhere in this repo yet. Drift
protection is `CONTRACT_VERSION` (checked by main on every /health poll) plus
a fixture (tests/fixtures/analysis_response_v1.json) parsed by both a Python
and a TypeScript test.

Field names are camelCase on the wire, matching every other IPC payload in
this app (packages/schema is all camelCase) — the alias generator below is
what lets the Python side stay snake_case internally.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator
from pydantic.alias_generators import to_camel

# Plausible epoch bounds: 1900-01-01T00:00:00Z .. 2100-01-01T00:00:00Z, in ms.
# Wide enough to admit every real record this app stores (earliest event
# 1900-01-31) and narrow enough to reject obvious garbage — the dev database
# already has a real cme_arrivals row with arrival_time_utc in the year 2914.
MIN_PLAUSIBLE_EPOCH_MS = -2208988800000
MAX_PLAUSIBLE_EPOCH_MS = 4102444800000


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


def _validate_epoch_ms(values: list[int], *, field: str) -> None:
    if any(not math.isfinite(v) for v in values):
        raise ValueError(f"{field} must be finite")
    if any(v < MIN_PLAUSIBLE_EPOCH_MS or v > MAX_PLAUSIBLE_EPOCH_MS for v in values):
        raise ValueError(f"{field} contains an implausible epoch (outside 1900-2100)")
    if any(b < a for a, b in zip(values, values[1:])):
        raise ValueError(f"{field} must be non-decreasing")


def _validate_lat_lon(latitude: list[float], longitude: list[float]) -> None:
    if any(not math.isfinite(v) or v < -90.0 or v > 90.0 for v in latitude):
        raise ValueError("latitude must be finite and within [-90, 90]")
    if any(not math.isfinite(v) or v < -180.0 or v > 180.0 for v in longitude):
        raise ValueError("longitude must be finite and within [-180, 180]")


class TriggerParameters(ApiModel):
    id: str
    series: Literal["kp", "dst"]
    comparison: Literal[">=", "<="]
    threshold: float
    min_consecutive_hours: int


class AnalysisParameters(ApiModel):
    target_min_magnitude: float
    triggers: list[TriggerParameters]
    lag_windows_hours: list[tuple[float, float]]
    declustering: Literal["gardner-knopoff"]
    baseline_window_days: float
    null_model: Literal["uniform-redraw"]
    tail: Literal["upper", "lower"]
    iterations: int
    seed: int
    q: float
    requested_start_utc: str
    registered_matrix_tests: int


class CatalogPayload(ApiModel):
    time_ms: list[int]
    latitude: list[float]
    longitude: list[float]
    magnitude: list[float]

    @model_validator(mode="after")
    def _check(self) -> "CatalogPayload":
        n = len(self.time_ms)
        if len(self.latitude) != n or len(self.longitude) != n or len(self.magnitude) != n:
            raise ValueError("catalog arrays must all be the same length")
        _validate_epoch_ms(self.time_ms, field="catalog.timeMs")
        _validate_lat_lon(self.latitude, self.longitude)
        if any(not math.isfinite(m) for m in self.magnitude):
            raise ValueError("catalog.magnitude must be finite")
        return self


class SeriesPayload(ApiModel):
    time_ms: list[int]
    kp: list[float | None]
    dst: list[float | None]

    @model_validator(mode="after")
    def _check(self) -> "SeriesPayload":
        n = len(self.time_ms)
        if len(self.kp) != n or len(self.dst) != n:
            raise ValueError("series arrays must all be the same length")
        _validate_epoch_ms(self.time_ms, field="series.timeMs")
        if any(v is not None and not math.isfinite(v) for v in self.kp):
            raise ValueError("series.kp must be finite where present")
        if any(v is not None and not math.isfinite(v) for v in self.dst):
            raise ValueError("series.dst must be finite where present")
        return self


class AnalysisRunRequest(ApiModel):
    contract_version: int
    hypothesis_id: Literal["H4c"]
    parameters: AnalysisParameters
    catalog: CatalogPayload
    series: SeriesPayload


# ---- Response ----


class SpanInfo(ApiModel):
    requested_start_utc: str
    used_start_utc: str
    used_end_utc: str
    truncation_reason: str | None = None


class CatalogInfo(ApiModel):
    min_magnitude: float
    raw_count: int
    declustered_count: int
    declustering: str


class TriggerInfo(ApiModel):
    id: str
    count: int
    eligible_hours: int


class NullHistogram(ApiModel):
    edges: list[float]
    counts: list[int]


class NullInfo(ApiModel):
    mean: float
    sd: float
    quantiles: dict[str, float]
    histogram: NullHistogram


class TestResult(ApiModel):
    id: str
    trigger_id: str
    lag_hours: tuple[float, float]
    observed: int
    expected: float
    ratio: float
    p_raw: float
    p_adjusted_within_run: float
    p_adjusted_full_matrix: float
    rejected_at_q: bool
    null: NullInfo


class CorrectionInfo(ApiModel):
    method: Literal["benjamini-hochberg"]
    q: float
    tests_run: int
    registered_matrix_tests: int
    deferred_tests: int
    blocked_tests: int
    partial_matrix: bool
    note: str


class MethodInfo(ApiModel):
    null_model: str
    tail: str
    baseline_window_days: float
    iterations: int


class AnalysisResult(ApiModel):
    contract_version: int
    engine_version: str
    hypothesis_id: str
    run_at_utc: str
    duration_ms: int
    seed: int
    span: SpanInfo
    catalog: CatalogInfo
    triggers: list[TriggerInfo]
    tests: list[TestResult]
    correction: CorrectionInfo
    method: MethodInfo
    caveats: list[str]


class HealthResponse(ApiModel):
    status: Literal["ok"]
    engine_version: str
    contract_version: int
    python: str


class HypothesisSummary(ApiModel):
    id: str
    implemented: bool
    tests_in_family: int
