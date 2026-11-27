# ADR 0003: Optional AI Natural-Language Itinerary Split Assistant

## Status

Accepted (2026-11-27)

## Context

Map & Posters is a local-first, single-file browser application (`index.html`) with strict v1 backup schema validation (`src/project.ts`) and full offline capability. Users splitting a multi-day GPX recording in Wizard Step 2 often know their itinerary in natural language (e.g., *"Day 1 finished in Pai, Day 2 was a rest day in Pai"*), yet manual map/slider splitting requires locating every boundary point by hand.

Introducing an AI assistant carries four architectural risks:
1. **Hallucinated geometry**: LLMs frequently emit inaccurate or off-route coordinates.
2. **Credential leakage**: Storing API keys in `Project` would export user secrets into `.json` trip backups and break or pollute schema v1.
3. **Silent destructive edits**: Applying AI guesses directly to `project.days` could corrupt an itinerary or choose the wrong pass on an out-and-back loop.
4. **Offline fragility & UI noise**: Mandatory network dependencies or prominent AI chrome would degrade the core offline manual workflow.

## Decision

1. **Strict Separation of LLM Parsing, Verified Geocoding, and Deterministic Snapping (`src/ai-split.ts`)**:
   - The LLM is used strictly as a natural-language-to-JSON parser returning structured day entries (`kind`, `name`, `endPlace`, `overnightPlace`, `passHint`). Any coordinates returned by the LLM are explicitly ignored.
   - Place names are resolved to `(lat, lon)` only via verified existing `project.places` (e.g. GPX waypoints) or GPX-bounded geocoding: optional Google Places API v1 (`places:searchText` with `locationBias.rectangle`) when a user supplies a Google Places key, falling back to free OSM Photon (`https://photon.komoot.io/api/`) constrained by the padded GPX `bbox`.
   - Resolved coordinates are deterministically snapped onto the included GPX track using local-minimum pass clustering so GPS jitter collapses to one visit while genuine repeated visits (out-and-backs/loops) surface as explicit selectable passes.
2. **Client-Side `localStorage`-Only Credentials (Schema v1 Untouched)**:
   - Provider (`openai` or `gemini`), API key, model, optional endpoint override (restricted to `https:` or `http://localhost`/`127.0.0.1`), and optional `map-and-posters:google-places-key` are stored exclusively in browser `localStorage`.
   - `Project` (`src/project.ts`) and `backup()`/`restore()` remain untouched at schema version 1, guaranteeing zero secrets ever enter exported trip backups.
3. **Two-Phase Review Before Mutation**:
   - `buildAiSplitPlan()` produces an immutable, reviewable `AiSplitPlan` containing proposed riding days, rest days, overnight stops, resolved distances, unresolved warnings, and multi-pass selectors (`selectPlanPass()`).
   - `project` is mutated only when the user explicitly clicks **Apply plan**, invoking `applyAiSplitPlan()` which preserves all `validateProject` invariants.
4. **Progressive Disclosure & Offline Degradation**:
   - Step 2 exposes the feature inside a native `<details>`/`<summary>` (`Ask AI to split days`) that starts collapsed and stays out of the way until opened.
   - Offline states (`navigator.onLine === false`) and network/API errors surface concise, recoverable messages without impairing manual map/slider splitting.

## Consequences

- **Positive**: Users get fast natural-language day splitting with verified on-track geometry, explicit multi-pass control, zero secret leakage in backups, zero server infrastructure, and full compatibility with both OpenAI-compatible APIs (including local Ollama/LM Studio) and Google Gemini.
- **Negative**: Browser-direct calls to third-party AI APIs depend on the chosen provider supporting CORS (OpenAI, Gemini, OpenRouter, and properly configured local servers do); users without an API key cannot run AI parsing, though manual splitting remains unaffected.
- **Compatibility**: Reuses the `map-and-posters:google-places-key` `localStorage` key convention so users configuring a Google Places key for autocomplete (Issue #23) automatically get Google Places geocoding in the AI assistant.
