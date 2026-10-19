"""Who may talk to the engine: Electron main, and nothing else.

The engine is an HTTP server on 127.0.0.1, and "only reachable from this
machine" is not the same as "only reachable by this app". Two callers
besides main can reach it, and before this guard both could make it run:

- **A web page in the user's browser.** A page may POST to any URL. With a
  `text/plain` body the browser asks nobody's permission first, and
  `Request.json()` parses the body whatever its declared type, so a page could
  start ten-minute H6 runs on a loop, or hand the engine a file path to open.
  It could not read the reply, but it did not need to.
- **Another user account on the same machine**, which shares 127.0.0.1.

Four checks, each closing a specific door:

1. **Host must be the loopback address.** DNS rebinding points an attacker's
   own hostname at 127.0.0.1, after which the browser treats the engine as
   that site and lets the page read replies too. The Host header still names
   the attacker's domain, so it is refused here.
2. **No Origin header.** Browsers attach one to every POST and every
   cross-origin request. Main's `fetch` (Node's) never does — measured — so
   its presence means a page sent the request.
3. **POSTs must be `application/json`.** A browser will not send that type to
   another origin without a CORS preflight, and the engine answers none.
   Redundant with (2) on purpose: two walls, either sufficient.
4. **The per-launch token, when one was given.** Main generates a random
   token at each launch and passes it in the environment of the engine it
   spawns. That is what shuts out other local accounts, which no
   header-based check can tell apart from main. An engine started by hand
   (`pnpm engine:dev`) has no token and relies on (1)-(3) — enough to stop a
   browser, which is the realistic threat on a dev machine.

Refusals are plain JSON `{"detail": ...}`, the shape main already reads.
"""

from __future__ import annotations

import hmac
import os
from collections.abc import Awaitable, Callable

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

TOKEN_ENV = "TERRA_PULSE_ENGINE_TOKEN"
TOKEN_HEADER = "x-terra-pulse-token"

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def token_from_environment() -> str | None:
    """The token main passed, or None for an engine started by hand."""
    token = os.environ.get(TOKEN_ENV, "").strip()
    return token or None


def host_name(host_header: str) -> str:
    """The host part of a Host header, without its port.

    `[::1]:8787` is IPv6 in brackets; anything else splits on the last colon.
    """
    host = host_header.strip().lower()
    if host.startswith("["):
        end = host.find("]")
        return host[1:end] if end > 0 else host
    return host.rsplit(":", 1)[0] if ":" in host else host


def refusal(request: Request, token: str | None) -> JSONResponse | None:
    """Why this request is refused, or None if it may proceed."""
    if host_name(request.headers.get("host", "")) not in LOOPBACK_HOSTS:
        return JSONResponse({"detail": "host not allowed"}, status_code=403)
    if "origin" in request.headers:
        return JSONResponse({"detail": "browser requests are not accepted"}, status_code=403)
    if request.method == "POST":
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            return JSONResponse({"detail": "content type must be application/json"}, status_code=415)
    if token is not None:
        supplied = request.headers.get(TOKEN_HEADER, "")
        # Constant time, so the token cannot be found a character at a time
        # by timing how long a wrong guess takes to be refused.
        if not hmac.compare_digest(supplied.encode(), token.encode()):
            return JSONResponse({"detail": "missing or wrong engine token"}, status_code=401)
    return None


def make_guard(
    token_source: Callable[[], str | None],
) -> Callable[[Request, Callable[[Request], Awaitable[Response]]], Awaitable[Response]]:
    """The middleware. The token is read through a callable so tests can set it."""

    async def guard(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        refused = refusal(request, token_source())
        if refused is not None:
            return refused
        return await call_next(request)

    return guard
