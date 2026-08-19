# CONTRACT_VERSION guards the request/response shape between this engine and
# Electron main. Bump it whenever a field's meaning changes (not merely when
# a field is added) — main checks it on every /health poll and refuses to
# treat a mismatched engine as usable rather than guessing at compatibility.
ENGINE_VERSION = "0.1.0"
CONTRACT_VERSION = 1
