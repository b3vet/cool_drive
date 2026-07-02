# CoolDrive

Low-poly, drift-focused 3D arcade driving game (three.js, zero-build ES modules,
offline-first; also shipped as a native iOS app via Capacitor).

## Design System
Always read **[DESIGN.md](DESIGN.md)** before making any visual or UI change.
Fonts, colors, spacing, the faceted/neon/tilted "low-poly arcade" shape language, and
motion are defined there. Do not deviate without explicit approval.

Key rules: cut-corner faceted panels (never bubbly uniform radius), neon edges (echo the
in-game kerbs), speed-tilt (`skewX`), left-anchored layout (never centered-everything),
display font **Chakra Petch** (self-hosted in `vendor/fonts/`), and the accent color
**shifts with the time-of-day preset** via `setAccent()` in `src/main.js`.

## Run
`npm start` → local static dev server. `npm run build:web` assembles `www/`.
`npm run ios` builds + syncs + opens Xcode. `npm run bump` increments the iOS build number.

## Deploy (web)
Docker (`Dockerfile` + `nginx.conf`) via Coolify. When deleting/adding a web asset,
update the `Dockerfile` COPY, `sw.js` CORE precache, and `scripts/build-www.mjs` together.
