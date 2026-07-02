# Quantra AI — UI/UX Design Brief

> ✅ done & live · ⬜ left

## Design vibe
Dark, cinematic, premium fintech ("textura.eu" aesthetic on the landing page;
Bloomberg-meets-glassmorphism in the terminal). Honest data first: numbers are
tabular, freshness is labeled, uncertainty is drawn (nested projection cones).

## Color palette (tokens in styles.css `:root`)
| Token | Value | Use |
|---|---|---|
| --bg / --bg-2 | #060912 / #0A0F1C | page background |
| --panel / --panel-2 | #0E1525 / #121A2E | cards |
| --text / --muted / --muted-2 | #E7ECF5 / #93A0B8 / #6B7890 | type scale |
| --mint | #34D399 | up / positive / brand |
| --cyan | #22D3EE | forecast / info |
| --indigo | #818CF8 | accents |
| --rose | #FB7185 | down / danger |
| --amber | #FBBF24 | warning / delayed |
| --grad | mint→cyan→indigo 100° | brand gradient (logo, headings, CTAs) |

## Typography
- **Space Grotesk** (600/700) — headings, numbers with personality.
- **Inter** (400–800) — body/UI. Tabular numerals on all data cells.

## Shape & depth
- Radii: 12 / 18 / 24 px (--r-sm/--r/--r-lg); soft shadow `0 24px 60px -24px`.
- 1px white-alpha hairlines (--line 8%, --line-2 14%); glassy panels; fixed
  background glows (mint + indigo radial blurs).
- Dark mode ONLY (by design — it's the brand). ⬜ light theme not planned.

## Signature elements (all live)
- Particle-nebula canvas hero on the landing page (Three.js r128, reduced-motion
  aware, DPR-capped) + kinetic gradient headline + bento feature grid. ✅
- Live dot pulse (`.live-dot`) on anything real-time; ⚡ millisecond tick readout. ✅
- Quantra Score ring; signal rows with ▲/▼; nested 50%/80% projection cones. ✅
- Verified-rows in projection table (✓ in 50% band / ✗ missed) — accountability as UI. ✅

## Responsiveness & a11y
- Fit-to-screen: `overflow-x:clip` globally; mobile grid collapses; touch chart
  tooltip (press to inspect, ms-precision in seconds mode). ✅
- `prefers-reduced-motion` respected on hero + animations. ✅
- ⬜ Full a11y audit (focus order, ARIA on custom widgets, contrast on muted-2).
- ⬜ Formal component library / Figma file — design lives in styles.css only.

## UI/UX checklist vs template
| Template item | Status |
|---|---|
| Color palette | ✅ tokenized |
| Fonts | ✅ |
| Style / design vibe | ✅ |
| Dark mode | ✅ (only mode) |
| Borders / radius / design elements | ✅ |
| Inspiration refs (Dribbble/Behance/Mobbin) | ✅ used textura.eu + Bloomberg refs |
| Design brief doc | ✅ this file (was previously only implicit in CSS) |
