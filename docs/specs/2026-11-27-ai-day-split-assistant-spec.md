# Spec: Optional AI Natural-Language Day-Split Assistant (Issue #21)

## Problem Statement

When importing a single multi-day GPX recording (or several recordings without reliable day boundaries) into Map & Posters, Step 2 (`Split into days`) currently requires riders to manually scrub the route slider or click the split map for every day boundary and manually add rest days and overnight stops. Many riders already know their itinerary in plain language — for example, *"Day 1 finished in Pai, Day 2 was a rest day in Pai"* — and want an optional way to turn that sentence into an accurate split without giving up control, breaking offline usage, or leaking API credentials into saved trip backups.

## Solution

Add an optional, collapsible **Ask AI** assistant to Wizard Step 2 (`Split into days`) backed by a pure, testable module (`src/ai-split.ts`). The assistant:

1. Accepts a natural-language itinerary description and sends a structured JSON-output request to a user-configured AI provider (OpenAI-compatible Chat Completions endpoint or Google Gemini `generateContent` endpoint).
2. Stores optional AI credentials, endpoint/model settings, and an optional Google Places key **exclusively in `localStorage`** — never inside `Project` or exported JSON backups, keeping `Project` schema v1 untouched.
3. Discards any raw coordinates emitted by the LLM and instead resolves extracted stop/town names to verified `(lat, lon)` coordinates using existing GPX waypoints or GPX-bounded geocoding (optional Google Places `places:searchText` with `locationBias`, falling back to free OSM Photon `https://photon.komoot.io/api/` bounded by `bbox`).
4. Deterministically snaps each verified coordinate onto the included GPX track, clusters GPS jitter into single visits while preserving distinct repeated passes (out-and-backs / loops), detects multi-pass ambiguity so the user can confirm which pass was intended, and renders an explicit, non-destructive review plan (`proposed days`, `rest days`, `overnight stops`, distances, and pass selectors).
5. Mutates `project` **only** when the user clicks **Apply plan**, preserving backup/restore schema v1 integrity and degrading cleanly offline or on network/provider failure.

## User Stories

1. **Out-of-the-way Optional Entry**: As a rider who prefers manual splitting, I want the AI helper collapsed behind a subtle native `<details>` trigger (`Ask AI`) in Step 2 so it never clutters the map or blocks manual splitting.
2. **Natural-Language Day & Rest-Day Splitting**: As a rider with a multi-day GPX track, I want to type *"Day 1 finished in Pai, Day 2 was a rest day in Pai"* and receive a concrete proposed itinerary showing Day 1 (split at Pai), Day 2 (rest day in Pai), and Day 3 (remaining route) before anything in my trip is modified.
3. **Verified GPX-Bounded Geocoding**: As a rider, I want place names extracted by AI to be geocoded within my GPX route's bounding box (via Google Places if configured, or free OSM Photon by default) rather than trusting hallucinated LLM coordinates.
4. **Multi-Pass Disambiguation**: As a rider whose route passes through the same town twice (such as an out-and-back or loop), I want the review plan to flag the ambiguity and let me pick Pass 1 vs. Pass 2 before applying, updating the proposed day distances immediately.
5. **Explicit One-Click Approval**: As a rider, I want to review every proposed split, rest day, and overnight stop and click **Apply plan** (or **Discard**) so AI never silently overwrites my itinerary.
6. **Zero Secrets in Trip Backups**: As a privacy-conscious user sharing `.json` trip backups, I want my AI API key, endpoint, and Google Places key kept strictly in browser `localStorage` and excluded from `Project` and `backup(project)`.
7. **Graceful Offline Degradation**: As a rider working offline or without an API key, I want a clear, calm error message when requesting an AI plan while manual map/slider splitting continues working without error.

## Implementation Decisions

### 1. Local-Only Configuration (`localStorage`)
- Keys stored strictly in `localStorage` (wrapped in `try/catch` for restricted environments):
  - `map-and-posters:ai-provider`: `'openai' | 'gemini'` (default `'openai'`)
  - `map-and-posters:ai-api-key`: optional API key string
  - `map-and-posters:ai-model`: optional model name (`'gpt-4o-mini'` default for OpenAI-compatible, `'gemini-2.5-flash'` default for Gemini)
  - `map-and-posters:ai-endpoint`: optional custom endpoint URL (restricted to `https:` or `http://localhost` / `http://127.0.0.1` for local LLM servers)
  - `map-and-posters:google-places-key`: optional Google Places API key (shared key convention with Issue #23)
- `Project` type (`src/project.ts`) and backup schema `version: 1` remain completely unchanged.

### 2. Structured LLM Extraction (`src/ai-split.ts`)
- Sends compact, non-sensitive route summary metadata (total distance, rounded bounding box, existing waypoint names) alongside the user's prompt.
- Requests strict JSON (`response_format: { type: 'json_object' }` for OpenAI-compatible; `generationConfig.responseMimeType: 'application/json'` for Gemini; Gemini key sent via `x-goog-api-key` header rather than query string).
- Parses `{ days: ParsedDaySpec[] }` where each entry describes `kind: 'ride' | 'rest'`, optional `name`, optional `endPlace`, optional `overnightPlace`, and optional `passHint` (`'first' | 'second' | 'last' | number`).
- Explicitly ignores any `lat`/`lon`/`coordinates` fields returned by the LLM.

### 3. GPX-Bounded Geocoding
- Computes a padded bounding box around all included GPX track points.
- Checks existing verified `project.places` (such as GPX waypoints) for a case-insensitive exact match first.
- Otherwise geocodes via Google Places API v1 (`places:searchText` with `locationBias.rectangle`) when `google-places-key` is configured, falling back to OSM Photon (`https://photon.komoot.io/api/?q=...&bbox=...&lat=...&lon=...&limit=5`).
- Validates coordinates via `validCoordinates(lat, lon)` and chooses the candidate closest to the GPX track; rejects candidates beyond the maximum snap threshold (`25 km` default) as unresolved rather than snapping to distant locations.

### 4. Deterministic Track Snapping & Pass Clustering
- Builds an ordered list of track samples across `combinedRanges` of the project's included riding days.
- Finds local distance minima near each resolved coordinate and clusters contiguous jitter/switchbacks (where the route never departs by more than `1.0 km` beyond the hit distance) into a single pass while preserving genuine repeated visits (out-and-backs / loops).
- Excludes route endpoints (`index === 0` or `index === last`) as split boundaries (matching `splitRanges` invariants), while recognizing when the final specified riding day's destination is at the end of the route so no spurious trailing day is created.
- Automatically appends an explicit remainder riding day when earlier splits leave unallocated track after the last mentioned day.
- Exposes `selectPlanPass(plan, stepId, candidateIndex)` to switch between multiple passes and immediately recalculate per-day distances and monotonic ordering validity.

### 5. Atomic Plan Application (`applyAiSplitPlan`)
- Validates the plan has no unresolved splits and that all split boundaries are strictly monotonic along the route.
- Reconstructs `project.days` via `splitRanges` and rest-day insertion, sets `project.manualOrder = true`, adds/reuses verified overnight `Place` entries (`visible: true`) and creates matching overnight `Visit` records (`position` snapped on riding days, `undefined` on rest days).
- Cleans up orphaned day references in `project.visits`, `project.photos` (reassigning to `''` while preserving the single trip hero invariant), and `project.output` (`groups`, `active`, `selected`, `labels`, `placeVisibility`, `placeText`), ensuring `restore(backup(project))` always passes v1 validation.

### 6. Step 2 Collapsible UI (`src/wizard.ts` & `src/editor.html`)
- Rendered as a native `<details class="wiz-ai">` with `<summary class="wiz-ai-trigger">Ask AI to split days</summary>`, closed by default.
- Contains labeled prompt `<textarea>`, collapsible settings `<details>` (provider, key, model, endpoint, optional Google Places key, clear keys), `Suggest split plan` action, status/error live region, and a review card with `<ol>` day breakdown, multi-pass `<select>` controls, `Apply plan`, and `Discard`.

## Testing Decisions

- **Unit Tests (`tests/ai-split.test.ts`)** using mocked `fetch` (zero live network calls):
  - `localStorage` config load/save/clear and endpoint URL validation.
  - OpenAI-compatible and Gemini request formatting and JSON parsing (including stripping LLM-hallucinated coordinates and handling malformed responses).
  - GPX-bounded geocoding via OSM Photon, Google Places `locationBias`, Google-to-Photon fallback, existing waypoint matching, and out-of-bounds rejection.
  - Deterministic snapping, GPS-jitter clustering (1 pass) vs. genuine out-and-back multi-pass detection (2 passes), `selectPlanPass` recalculation, and monotonic validation errors.
  - Plan generation for *"Day 1 finished in Pai, Day 2 was a rest day in Pai"* (auto-appends Day 3 remainder, sets overnight stops).
  - `applyAiSplitPlan` mutating `project`, preserving backup v1 validity (`restore(backup(project))`), and verifying zero API keys/endpoints appear in `backup(project)`.
  - Offline / network failure degradation.
- **Workflow Tests (`tests/workflow.test.ts`)** using mocked `fetch` in JSDOM:
  - Opening Step 2 with `Ask AI` collapsed by default, expanding it, configuring key/provider, prompting *"Day 1 finished in Pai, Day 2 was a rest day in Pai"* on an out-and-back route, confirming multi-pass selector appears, picking Pass 2, clicking `Apply plan`, verifying days/rest day/overnight place/backup cleanliness, and verifying offline error handling leaves manual splitting intact.

## Out of Scope

- Server-side proxy or hosted AI key management (Map & Posters is a single-file local-first browser app).
- Automatic mutation of `project` without user confirmation.
- Modifying `Project` backup schema version 1.
- AI photo captioning or poster layout generation.
