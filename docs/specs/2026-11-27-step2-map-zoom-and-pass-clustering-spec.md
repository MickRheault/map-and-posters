# Step 2 Split Map Zoom & Pan and Pass Clustering

**Date**: 2026-11-27  
**Status**: Approved  
**Issue**: #22  
**Related**: [ADR 0001](../adr/0001-step2-map-zoom-and-pass-clustering.md)

## Problem Statement

When splitting a multi-day or switchback-heavy GPX route on Step 2 (`Split into days`) or in the Full Editor's Itinerary boundary editor:

1. **Noisy `Pass 1..5` micro-increments**: Both `src/wizard.ts` and `src/itinerary-ui.ts` currently treat every local distance minimum within `best + 3` SVG units as a separate pass. On real GPX tracks containing GPS jitter, town zigzags, or tight mountain switchbacks, clicking a single spot produces 3–10 nearly identical passes (e.g. `Pass 1 · 12.1 km`, `Pass 2 · 12.2 km`, `Pass 3 · 12.3 km`) for the same continuous visit.
2. **No zoom or pan on Step 2 split map**: Long multi-day GPX tracks rendered inside a fixed `400 × 200` SVG make it difficult to place a boundary accurately inside a town, junction, or overlapping out-and-back section without zooming in and panning across the route.

## Goals & Scope

### In Scope

1. **Shared pure Pass Clustering helper (`pickBoundaryPasses` in `src/itinerary.ts`)**:
   - Used by both `src/wizard.ts` (Step 2 split map) and `src/itinerary-ui.ts` (Full Editor `boundaryEditor`).
   - Uses a hysteresis state machine over valid boundary indices (`1 .. samples.length - 2`):
     - `hitMargin` defaults to `3 / zoom` base SVG units (matches existing `best + 3` tolerance at `1×` and tightens proportionally when zoomed in).
     - `leaveMargin` defaults to `12 / zoom` base SVG units (at least `2 × hitMargin`).
     - Consecutive hits while `distance <= best + leaveMargin` are merged into a single Pass represented by the closest sample in that visit cluster.
     - A new Pass starts only after the route genuinely leaves the neighborhood (`distance > best + leaveMargin`) and later returns within `best + hitMargin`.
   - Preserves clear `Pass N · X.X km` labeling (`Pass N · X.X km · <recording>` in Full Editor) and hides the pass selector whenever fewer than 2 distinct passes match.
   - Still distinguishes genuine short and long out-and-backs (including all existing tests in `tests/itinerary.test.ts` and `tests/workflow.test.ts`).

2. **Lean Zoom & Pan on Step 2 split map (`src/wizard.ts` & `src/editor.html`)**:
   - Compact, accessible zoom control group (`-`, `+`, `Reset`) floating neatly in the top-right corner of the Step 2 split map container, keeping the wizard layout minimal and centered.
   - `+` and `-` zoom smoothly around the current viewport center (clamped to `[1, 16]`); `Reset` restores `1×` full-route framing. `-` and `Reset` are disabled at `1×`; `+` is disabled at max zoom (`16×`).
   - Mouse wheel (`wheel` event with `preventDefault()`) zooms around the cursor's map coordinate.
   - Pointer drag (`pointerdown` / `pointermove` / `pointerup`) pans the zoomed SVG `viewBox` clamped within `[0, 400] × [0, 200]`.
   - Drag-vs-click disambiguation (5 CSS px threshold) ensures dragging never triggers an accidental boundary pick, while clicking while zoomed and panned converts client coordinates through the active `viewBox` and picks the exact track point under the cursor.
   - Route stroke width and boundary marker radius scale inversely with zoom so zoomed routes remain sharp and readable.
   - Pure viewport math helpers (`clampMapView`, `zoomMapView`, `panMapView`, `clientToMapPoint`) live in `src/itinerary.ts` for deterministic unit testing.

3. **Accessibility & Offline Preservation**:
   - Native `<button type="button">` zoom controls with accessible names (`Zoom in`, `Zoom out`, `Reset`), minimum target sizes (`≥ 28×28` CSS px), and visible focus outlines.
   - `role="img"` on the inline split-map `<svg>` alongside its `aria-label`.
   - `touch-action: none` applied only while zoomed in (`.is-zoomed`) so unzoomed page/dialog scrolling stays native.
   - Zero external dependencies and zero `Project` schema changes (backup format v1 remains untouched).

### Out of Scope

- Basemap tiles, third-party mapping libraries, or network calls.
- Zoom/pan on the Full Editor's small sidebar SVG or Step 1 route silhouette preview.
- Changes to `visitCandidates` in `src/assets-ui.ts` or `Project` schema v1.

## Testing Strategy

1. **Unit tests (`tests/itinerary.test.ts`)**:
   - Noisy GPS jitter and tight switchback micro-oscillations along one visit collapse to 1 pass (choosing the closest point).
   - Noisy switchback followed by a genuine return visit produces exactly 2 passes.
   - Real out-and-backs (both wide and short spurs leaving the neighborhood) still produce 2 passes.
   - Zooming in tightens `hitMargin` and `leaveMargin` so tightly spaced parallel/switchback approaches can be resolved intentionally when zoomed.
   - Pure viewport math (`clampMapView`, `zoomMapView`, `panMapView`, `clientToMapPoint`) enforces bounds, preserves anchor coordinates on zoom, and maps zoomed/panned client clicks accurately.
2. **Workflow E2E tests (`tests/workflow.test.ts`)**:
   - Step 2 zoom controls (`+`, `-`, `Reset`) and mouse wheel zoom update the SVG `viewBox` and button disabled states.
   - Pointer drag while zoomed pans `viewBox` without changing the split point (even when followed by a release click).
   - Clicking while zoomed and panned selects the accurate route boundary at the transformed map coordinate.
   - Clicking a jittery switchback on Step 2 keeps the `Matching visits` selector hidden, while clicking an out-and-back offers 2 distinct passes.
3. **Verification**: `npm run check` (updates `index.html`) followed by `npm run verify` exits `0`.
