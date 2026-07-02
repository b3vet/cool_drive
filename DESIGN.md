# Design System — CoolDrive

> Read this before any visual/UI change. Colors, fonts, spacing, shape language,
> and motion are defined here. Don't deviate without explicit approval.

## Product Context
CoolDrive is a low-poly, drift-focused 3D arcade driving game (three.js, offline-first,
also shipped as a native iOS app). The UI chrome (start screen, settings sidebar, HUD)
must feel like part of that world — an arcade attract screen, not a web landing page.

## Aesthetic Direction — "Low-poly arcade"
Retro-futurist / low-poly arcade. Three signatures, each grounded in the 3D world:
- **Cubic / faceted** — panels have cut corners (`clip-path`), echoing the game's
  low-poly buildings. No bubbly uniform border-radius.
- **Neon-edged** — a thin neon edge on panels (via `box-shadow: inset 0 0 0 1.5px`,
  which follows the clip-path) + `filter: drop-shadow()` glow on selected/hover,
  echoing the in-game glowing kerbs and barriers.
- **Tilted for speed** — the logo (and combo/celebration HUD) are `skewX(-7deg)`;
  cards *lean* on hover (`translateY + rotate`), echoing a drifting car's weight-shift.

Layout is **left-anchored on a faint grid**, not dead-centered (centered-everything is
the #1 "AI slop" tell). Decoration is **intentional**, not maximalist — the 3D world
behind the menu stays the hero.

### Anti-patterns (never reintroduce)
Gradient pill CTAs, gradient-clipped logo text, uniform bubbly radius, frosted-glass
rgba panels with no edge, purple/violet default accents, centered symmetric everything.

## Typography
- **Display** — **Chakra Petch** (600, 700). Angular, mechanical, cut-corner — reads
  "cubic/racing". Self-hosted at `vendor/fonts/chakra-petch-{600,700}.woff2` (latin
  subset, ~10KB each) so it works offline and in the native bundle. `--disp` token.
  Used for: logo, all UPPERCASE tracked labels, mode/car names, buttons, and every
  HUD read-out (score, speed, combo — `font-variant-numeric: tabular-nums`).
- **Body** — system stack (`ui-sans-serif, system-ui, …`). Descriptive text / blurbs.
  Kept as system to stay lean; the identity comes from the display face + shapes.

## Color
The palette is the game's **in-engine** palette — every color is already on screen in
the 3D world, so the UI coheres with whatever time-of-day preset is active.

| Role | Token / Hex | Contrast on `#0b1020` |
|---|---|---|
| Ink / bg | `--ink` `#0b1020` | — |
| Panel | `--panel` `#111a30` | surface |
| Text | `--fg` `#f4f7ff` | ~17:1 · AAA |
| Muted text | `--muted` `#8a93ad` | ~4.6:1 · AA (use ≥14px) |
| **Accent (neon)** | `--accent` (shifts per preset) | 10.8–13:1 · AAA |
| Gold / records | `--gold` `#ffd24a` | ~11:1 · AAA |
| Hot / brake | `--hot` `#ff5a4d` | ~5.2:1 · AA |

**The accent recolors with the sky.** `setAccent(hexNum)` in `src/main.js` sets
`--accent` + derived tints (`--accent-soft` .13, `--accent-dim` .42, `--accent-glow` .5)
from the active preset's `neon` — Golden `#33e0a1`, Dawn `#4ad6ff`, Night `#44ffd6`.
Called on init and in `cyclePreset()`. Use the `--accent*` tokens (not literals) for
anything that should follow the sky. All meet WCAG AA (AAA for text/large).

## Shape Language & Tokens (CSS)
```
--bevel: 13px;
--facet:    polygon(13px 0, 100% 0, 100% calc(100% - 13px), calc(100% - 13px) 100%, 0 100%, 0 13px);
--facet-sm: polygon(7px 0, …7px…);   /* small controls */
.facet { clip-path: var(--facet); box-shadow: inset 0 0 0 1.5px var(--line); }
/* selected: box-shadow inset accent + filter: drop-shadow(0 0 16px var(--accent-glow)) */
```
Faceting is single-element (no wrapper divs) — the inset box-shadow follows the
clip-path for the edge; drop-shadow renders the glow past the clip.

## Spacing
8px base grid. Confident density, generous gutters between faceted tiles. The start
screen shows a faint 46px background grid. Mobile-landscape (short viewport) has compact
overrides (`body.mobile …`) that shrink type and hide mode blurbs.

## Motion
Intentional, on-theme, honors reduced-motion where practical:
- Tiles **lean** on hover: `translateY(-3px) rotate(±.6–.7deg)`.
- CTA **charges**: neon outline → filled + `drop-shadow` glow on hover.
- Logo / combo / celebration are **skewed** (`skewX(-6/-7deg)`) for speed.
- Settings slides in from the right with a neon left edge.

## Decisions Log
- **2026-07-02** — Adopted "Low-poly arcade": faceted cut-corner panels + neon edges +
  speed-tilt, replacing the generic rounded/gradient "AI slop" start screen & settings.
  Applied to start screen, settings sidebar, AND in-game HUD for full consistency.
  Self-hosted Chakra Petch (offline-first). Accent shifts with the time-of-day preset.
  Implementation lives in `index.html` (`<style>`) + `src/main.js` (`setAccent`).
