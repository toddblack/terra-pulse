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
    series: Literal["kp", "dst", "wind_speed"]
    comparison: Literal[">=", "<="]
    threshold: float
    min_consecutive_hours: int


class LagWindowParameters(ApiModel):
    """H4c/H3b's shape: a threshold trigger on a continuous series, tested
    against a moving-window Poisson baseline over fixed lag windows."""

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


class HemisphereParameters(ApiModel):
    """H2b's shape: a discrete trigger (CME arrivals) tested by hemispheric
    rate ratio, not against a Poisson baseline — there is no
    `baselineWindowDays` here, deliberately, since this test shape has no
    baseline-rate component at all."""

    target_min_magnitude: float
    spatial_split_degrees: float
    lag_windows_hours: list[tuple[float, float]]
    declustering: Literal["gardner-knopoff"]
    null_model: Literal["uniform-redraw"]
    tail: Literal["upper", "lower"]
    iterations: int
    seed: int
    q: float
    requested_start_utc: str
    registered_matrix_tests: int


class DiscreteLagWindowParameters(ApiModel):
    """H1b's shape: a *discrete catalogued* trigger (solar flare peaks) tested
    against a moving-window Poisson baseline over fixed lag windows.

    Deliberately its own model rather than `LagWindowParameters` with an
    optional `triggers`. That field carries a `series` literal, a comparison
    and a `minConsecutiveHours` — the anatomy of a threshold crossing on a
    continuous series, none of which means anything for a list of flares
    already classified by NOAA. There is no series literal that could name
    "M1.0+ flare peak times", and adding a nullable one would reintroduce the
    "field present but silently unused" shape the split exists to prevent.

    Everything else *is* H4c/H3b's, including `baselineWindowDays` — H1b
    registers the same ±182.625-day moving window, for the secular-drift
    reason its own registration documents.
    """

    target_min_magnitude: float
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


class AntipodalParameters(ApiModel):
    """H5's shape: no lag *windows* (one registered 0-72h window), no Poisson
    baseline, no spatial split, no continuous series, and no trigger list — the
    trigger set is derived from the same catalogue as the targets, because one
    Gardner-Knopoff pass has to produce both or they disagree about which
    events are independent.

    Its own model rather than optional fields on an existing one, by the same
    argument as `DiscreteLagWindowParameters`: the parameters genuinely differ,
    and nullable fields across families are the "present but silently unused"
    shape non-negotiable #3 rules out.
    """

    target_min_magnitude: float
    trigger_min_magnitude: float
    window_hours: tuple[float, float]
    declustering: Literal["gardner-knopoff"]
    null_model: Literal["uniform-redraw"]
    tail: Literal["upper", "lower"]
    # The reference CDF's bin width. Registered rather than tuned — see the
    # note in pipeline/ks.py on why 100 km is far finer than the data resolves.
    distance_bin_km: float
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
    wind_speed: list[float | None]

    @model_validator(mode="after")
    def _check(self) -> "SeriesPayload":
        n = len(self.time_ms)
        if len(self.kp) != n or len(self.dst) != n or len(self.wind_speed) != n:
            raise ValueError("series arrays must all be the same length")
        _validate_epoch_ms(self.time_ms, field="series.timeMs")
        if any(v is not None and not math.isfinite(v) for v in self.kp):
            raise ValueError("series.kp must be finite where present")
        if any(v is not None and not math.isfinite(v) for v in self.dst):
            raise ValueError("series.dst must be finite where present")
        if any(v is not None and not math.isfinite(v) for v in self.wind_speed):
            raise ValueError("series.windSpeed must be finite where present")
        return self


class LagWindowRunRequest(ApiModel):
    contract_version: int
    hypothesis_id: Literal["H4c", "H3b"]
    parameters: LagWindowParameters
    catalog: CatalogPayload
    series: SeriesPayload


class HemisphereRunRequest(ApiModel):
    contract_version: int
    hypothesis_id: Literal["H2b"]
    parameters: HemisphereParameters
    catalog: CatalogPayload
    cme_arrival_times_ms: list[int]

    @model_validator(mode="after")
    def _check(self) -> "HemisphereRunRequest":
        _validate_epoch_ms(self.cme_arrival_times_ms, field="cmeArrivalTimesMs")
        return self


class DiscreteTriggerRunRequest(ApiModel):
    """H1b. No `series` — its triggers arrive as instants, like H2b's, rather
    than being derived from an hourly grid the way H4c's and H3b's are.

    `flareCoverageComplete` is not a statistical parameter and does not appear
    in HYPOTHESES.md. It reports whether main actually holds the registered
    GOES 1996-2016 record, so a run against a partly-downloaded catalogue is
    marked rather than silently reported as if it were the registered one —
    the same posture as the recurrence panel refusing on an incomplete
    archive.
    """

    contract_version: int
    hypothesis_id: Literal["H1b"]
    parameters: DiscreteLagWindowParameters
    catalog: CatalogPayload
    flare_peak_times_ms: list[int]
    flare_coverage_complete: bool

    @model_validator(mode="after")
    def _check(self) -> "DiscreteTriggerRunRequest":
        _validate_epoch_ms(self.flare_peak_times_ms, field="flarePeakTimesMs")
        return self


# The manual per-hypothesis dispatch in api/main.py picks the right member of
# this union by `hypothesisId` before validating — see that module's own
# note on why this isn't a single shared request model or a Pydantic
# discriminated union: each hypothesis family's parameters genuinely differ
# (H2b has no baseline window at all), and forcing them into one model would
# mean marking fields optional across families, which is exactly the kind of
# "field present but silently unused" shape non-negotiable #3 exists to rule
# out.
class AntipodalRunRequest(ApiModel):
    """H5. Carries only parameters and one catalogue.

    No separate trigger payload, unlike H2b's arrival instants and H1b's flare
    peaks: H5's triggers are themselves earthquakes drawn from the same M5.0+
    catalogue as its targets, and declustering must see all of them in one pass
    — a Gardner-Knopoff sweep over an M6.0+-only subset marks a different set of
    events independent. So the engine derives both sets from one mask rather
    than main sending two lists that could disagree.
    """

    contract_version: int
    hypothesis_id: Literal["H5"]
    parameters: AntipodalParameters
    catalog: CatalogPayload


class TidalParameters(ApiModel):
    """H6's shape.

    No baseline window, no lag windows, no trigger list and no series: the
    statistic is a concentration of *phase*, and phase is computed from the
    ephemeris rather than read off anything main can send. What main does have
    to send is the one thing the engine cannot compute — where the DE440 kernel
    is on this machine.
    """

    target_min_magnitude: float
    declustering: Literal["gardner-knopoff"]
    null_model: Literal["uniform-redraw"]
    tail: Literal["upper"]
    # Absolute path to `de440s.bsp`. Travels in the request rather than the
    # engine's environment because in dev the engine is *adopted*, not spawned,
    # so main never gets to set its environment. See
    # apps/desktop/src/main/ipc/ephemeris.ts.
    ephemeris_path: str
    # Grid step for the shear-stress series the phase is read from. Registered
    # as an implementation resolution, not a free parameter: the phase is
    # defined by the series' own extrema, and this only controls how precisely
    # they are located. Measured error at 1 h is p50 0.16 deg, p99 2.75 deg.
    phase_grid_hours: float
    # "for presentation and the sinusoidal fit only" -- HYPOTHESES.md H6. The
    # statistic itself is unbinned.
    phase_bins: int
    # A hypocentre within this distance of a Slab2 trench line counts as a
    # subduction-zone event. Registered at 300 km, before any result existed.
    subduction_radius_km: float
    iterations: int
    seed: int
    q: float
    requested_start_utc: str
    registered_matrix_tests: int


class OrientedCatalogPayload(ApiModel):
    """The catalogue plus each event's fault orientation, where one exists.

    `np1_*` is Global CMT's **first** nodal plane and there is deliberately no
    field for the second. Resolved shear is identical on conjugate planes, so
    the second carries no information — and GCMT rounds both to whole degrees,
    so an implementation given both would find a ~1.3% median disagreement that
    is publication precision wearing the appearance of physics. See
    HYPOTHESES.md H6 and packages/schema/src/focal-mechanisms.ts.

    Events with no matched mechanism carry `None` and are excluded from the
    target set by `run_h6` — *after* declustering, never before, because a
    dependent event still shadows its neighbours whether or not anyone
    inverted a mechanism for it.
    """

    time_ms: list[int]
    latitude: list[float]
    longitude: list[float]
    magnitude: list[float]
    np1_strike: list[float | None]
    np1_dip: list[float | None]
    np1_rake: list[float | None]

    @model_validator(mode="after")
    def _check(self) -> "OrientedCatalogPayload":
        n = len(self.time_ms)
        for name in ("latitude", "longitude", "magnitude", "np1_strike", "np1_dip", "np1_rake"):
            if len(getattr(self, name)) != n:
                raise ValueError("catalog arrays must all be the same length")
        _validate_epoch_ms(self.time_ms, field="catalog.timeMs")
        _validate_lat_lon(self.latitude, self.longitude)
        if any(not math.isfinite(m) for m in self.magnitude):
            raise ValueError("catalog.magnitude must be finite")
        # A partially-populated mechanism is a join bug, not a missing value:
        # all three angles come from one NDK record or none do.
        for strike, dip, rake in zip(self.np1_strike, self.np1_dip, self.np1_rake, strict=True):
            present = [v is not None for v in (strike, dip, rake)]
            if any(present) and not all(present):
                raise ValueError("np1 strike/dip/rake must be present together or absent together")
        return self


class TrenchPayload(ApiModel):
    """Slab2 trench vertices, for the subduction-zone subset.

    Sent by main rather than vendored into the engine so there is one copy of
    this dataset in the repo — the globe already draws it. Densification is
    main's job; this is consumed as points.
    """

    latitude: list[float]
    longitude: list[float]

    @model_validator(mode="after")
    def _check(self) -> "TrenchPayload":
        if len(self.latitude) != len(self.longitude):
            raise ValueError("trench arrays must be the same length")
        _validate_lat_lon(self.latitude, self.longitude)
        return self


class TidalRunRequest(ApiModel):
    """H6. One catalogue carrying orientations, plus the trench geometry."""

    contract_version: int
    hypothesis_id: Literal["H6"]
    parameters: TidalParameters
    catalog: OrientedCatalogPayload
    trenches: TrenchPayload

AnalysisRunRequest = (
    LagWindowRunRequest
    | HemisphereRunRequest
    | DiscreteTriggerRunRequest
    | AntipodalRunRequest
    | TidalRunRequest
)


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
    # What `observed`, `expected` and `ratio` actually are, when they are not
    # an observed count, a Poisson expectation and their ratio.
    #
    # All three fields are required and every hypothesis has to put *something*
    # in them, so a hypothesis with a different statistic repurposes them —
    # H2b's are near/far hemisphere counts, H5's are a sample size and a
    # two-sided D. Without labels the table renders those under headers reading
    # "Observed" and "Expected", which is not a rendering nit: it states
    # something false about what the number is. Null means the default reading
    # holds.
    observed_label: str | None = None
    expected_label: str | None = None
    # What `ratio` actually is, when it is not a ratio.
    #
    # `ratio` has to hold whatever statistic the null histogram was built from,
    # because the UI draws its observed-value guide line from this field — so a
    # hypothesis whose statistic is not a ratio cannot park it elsewhere. H5's
    # is a KS D-plus; H2b's is a near/far count ratio that the table
    # nonetheless labels "Observed"/"Expected". Absent (the H4c/H3b/H1b case)
    # means it really is an observed/expected ratio and renders with the
    # existing 'x' suffix.
    statistic_label: str | None = None
    # Circular descriptives, for a hypothesis whose statistic is a
    # concentration on a circle rather than a rate. H6 is the only one so far.
    #
    # `preferred_phase_deg` is the direction of Schuster's resultant — the
    # phase events cluster toward, if any. It is reported even when the
    # resultant is at its noise floor, because withholding it would make a null
    # look like a missing value rather than a null.
    #
    # `phase_histogram` is the registered 12-bin presentation view, running
    # from -180. HYPOTHESES.md H6 is explicit that the binning is "for
    # presentation and the sinusoidal fit only" — the statistic itself is
    # unbinned, so nothing about the p-value depends on it.
    preferred_phase_deg: float | None = None
    phase_histogram: list[int] | None = None


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
    iterations: int
    # Exactly one of these two is populated, matching which parameter shape
    # the hypothesis actually registers — see LagWindowParameters vs
    # HemisphereParameters. Both stay in one response shape (rather than a
    # second discriminated union on the way out) because the UI already
    # renders one generic results panel for every hypothesis.
    baseline_window_days: float | None = None
    spatial_split_degrees: float | None = None
    # How a hypothesis meets a registered completeness requirement, when it has
    # one. H5's is the only one so far, and it is the parameter the whole test
    # turns on — without this field the results panel would show every
    # registered parameter *except* the one a reader most needs to check.
    completeness_model: str | None = None


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
