# Sounds

The large-event alert sound is **`eq-alert.mp3`** (~0.4 s, 128 kbps mono).

The filename is not magic — it is read from `ALERT_SOUND_URL` in
`src/renderer/src/audio/alert-sound.ts`. Change one and change the other.

## Why `public/` and not `src/assets/`

Vite's `public/` directory is copied verbatim and served from the app root, so
the file is referenced by URL (`/sounds/eq-alert.mp3`) rather than imported.

That matters here for two reasons:

- **A missing file doesn't break the build.** A static `import` of an absent
  asset is a build error; a URL that 404s is a runtime miss the player already
  handles by staying silent. The app works whether or not this file exists.
- **It can be swapped without rebuilding.** Replace the mp3, restart, done —
  no bundler involved, no content hash to chase.

Anything in `src/assets/` would be fingerprinted and inlined by the bundler,
which is the right choice for assets the code depends on and the wrong one for
a file the user is expected to supply and change.

## Format

Electron's Chromium handles `.mp3`, `.ogg`, `.wav` and `.m4a`. Whichever you
use, `ALERT_SOUND_URL` has to match.

Keep it short. This plays on every M5.8+ arrival, roughly once every day and a
half, and a long sample is a sound you will come to resent.
