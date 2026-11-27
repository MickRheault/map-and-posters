# Optional Place Autocomplete (Google Places API + OSM Photon Fallback)

**Date**: 2026-11-27  
**Status**: Approved  
**Issue**: #23  
**Related**: [ADR 0002 — Optional Place Autocomplete Provider Architecture](../adr/0002-optional-places-autocomplete-provider.md)

## Problem Statement

When building a multi-day trip poster in the Guided Wizard, users currently have to look up raw latitude/longitude pairs or copy map URLs manually in two places:

1. **Step 3 (`Pick stops` → `+ Add place`)**: Adding a stop requires typing a name and pasting coordinates or a map link into a second field.
2. **Step 2 (`Split into days`)**: Finding where a specific town or overnight stop sits along a long GPX route requires scrubbing the slider or guessing visually on an unlabeled route silhouette.

At the same time, Map & Posters is a local-first, offline-capable single-file app (`index.html`) with a strict `Project` v1 backup schema that must never store API keys or break when the user is offline.

## Goals & Scope

### In Scope
1. **Pure place search module (`src/places-search.ts`)**:
   - Computes padded geographic bounding boxes (`trackBounds`) from included GPX tracks, safely handling empty tracks and antimeridian crossings.
   - **Default zero-config provider**: Free OpenStreetMap Photon (`https://photon.komoot.io/api/`) biased to the GPX bounding box (`bbox` + `lat`/`lon`), with automatic fallback to center-biased (`lat`/`lon`) search if strict `bbox` yields zero matches.
   - **Optional Google Places API (New, v1) provider**: Activated when the user saves an API key in `localStorage` under `map-and-posters:google-places-key`. Uses `POST https://places.googleapis.com/v1/places:autocomplete` with `locationBias.rectangle` and resolves coordinates on selection via `GET https://places.googleapis.com/v1/places/{placeId}` (sharing an optional session token).
   - **Key isolation**: The optional Google Places API key is read/written strictly via `localStorage` (`map-and-posters:google-places-key`), never stored on `Project`, IndexedDB `projects`, or JSON backups. `Project` schema v1 remains completely unchanged.
   - **Graceful offline & error degradation**: Network errors, HTTP errors (401/403/429/5xx), missing `fetch`, and aborted requests return structured outcomes without throwing unhandled exceptions, keeping manual coordinate / map-link entry 100% functional.
   - **Route snapping helper (`snapPlaceToRoute`)**: Snaps a resolved `(lat, lon)` coordinate onto interior points (`1 .. samples.length - 2`) of the active day's GPX samples, clustering consecutive in-range points into distinct passes so out-and-back / multi-pass visits are surfaced cleanly for disambiguation.
2. **Wizard Step 3 (`Pick stops` → `+ Add place`)**:
   - Typing at least 2 characters in `Place name` triggers debounced, abort-safe place autocomplete suggestions rendered as an accessible list of buttons (`<ul role="list">` with `<button type="button">`).
   - Selecting a suggestion resolves coordinates (instant for Photon; details fetch for Google Places), populates both `Place name` and `Location` (`lat, lon`), clears suggestions, and lets the user confirm with `Add`.
   - Includes a subtle inline `Google key` settings toggle (`aria-expanded` / `aria-controls`) that lets the user save or clear their Google Places API key in `localStorage` with clear notice that the key stays in this browser only and is never exported in backups.
   - Keyboard accessible: `ArrowDown` / `ArrowUp` navigate suggestions; `Escape` dismisses suggestions without closing the `<dialog>`.
3. **Wizard Step 2 (`Split into days`)**:
   - Subtle compact `Find place` toggle (`aria-expanded` / `aria-controls`) that opens a semantic `<search>` panel above the split map.
   - Searching and selecting a place resolves its coordinates, snaps to the closest interior point(s) on the active day's GPX route via `snapPlaceToRoute`, moves the split marker to the best pass, and populates the existing `Matching visits` `<select>` whenever multiple distinct passes exist.
   - Never mutates the itinerary automatically — the user reviews the moved split marker (and pass choice if multiple) and confirms with `Split here`.
4. **Tests**:
   - Comprehensive unit tests in `tests/places-search.test.ts` covering GPX bounding box padding/antimeridian handling, Photon bbox + fallback query formatting and GeoJSON parsing, Google Places autocomplete + place details resolution, `localStorage` key persistence, offline/HTTP error degradation, and `snapPlaceToRoute` single-pass & multi-pass clustering — all with mocked `fetch`.
   - End-to-end JSDOM workflow tests in `tests/workflow.test.ts` covering Step 3 autocomplete (Photon + Google key toggle + offline fallback + verifying backups never contain the key) and Step 2 `Find place` snapping with multi-pass disambiguation + `Split here` — zero live network calls.

### Out of Scope
- Changing `Project` schema v1, IndexedDB schema, or JSON backup format.
- Adding a backend proxy server or bundling any API keys in source code.
- Adding external npm dependencies.
- Modifying the full-editor sidebar (`src/assets-ui.ts` / `src/itinerary-ui.ts`) beyond keeping it completely intact.

## Acceptance Criteria

1. Typing a place name in Step 3 `+ Add place` queries Photon by default (when no Google key is saved) with GPX bounds bias, renders accessible suggestion buttons, and fills `Place name` + `Location` when clicked.
2. Saving a Google key via the Step 3 `Google key` toggle persists it ONLY in `localStorage['map-and-posters:google-places-key']`, switches autocomplete to Google Places API v1 (`places:autocomplete` + `places/{id}`), and clearing the key reverts immediately to Photon.
3. Downloading a JSON backup (`backup(project)`) NEVER includes the Google Places API key, and `restore()` continues validating v1 backups unchanged.
4. When offline or when `fetch` fails/rejects/returns HTTP errors, Step 3 shows a calm non-blocking status message and manual coordinate / map-link entry continues working seamlessly.
5. Clicking `Find place` in Step 2 lets the user search a city/stop, snaps to the active day's GPX track, populates `Matching visits` when multiple distinct passes occur (e.g. out-and-back), moves the split marker, and lets `Split here` create the day split at the chosen pass.
6. All TypeScript checks, unit tests, workflow tests, and `index.html` rebuild pass cleanly via `npm run verify`.
