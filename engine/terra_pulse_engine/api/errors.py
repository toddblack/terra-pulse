"""A typed failure envelope. The engine must never hand a bare Python
traceback back to Electron main — main degrades quietly on failure (the
project's established tone; see nasa-donki.ts's controller), and it can only
do that if failures arrive as a small, predictable shape.
"""

from __future__ import annotations

import logging

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("terra_pulse_engine")


class ErrorResponse(BaseModel):
    error: str
    detail: str


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled error while serving %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content=ErrorResponse(
            error="internal-error",
            # Trimmed to one line — a full traceback belongs in the engine's
            # own log, not in a payload a renderer might display.
            detail=f"{type(exc).__name__}: {exc}".splitlines()[0],
        ).model_dump(),
    )
