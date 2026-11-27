import { addPlace, validCoordinates, type Coordinates, type Place, type Visit } from './assets'
import { combinedRanges, splitRanges, type Day, type PointRef, type Range } from './itinerary'
import type { Project } from './project'
import { distance } from './track'

export type AiProvider = 'openai' | 'gemini'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const AI_STORAGE_KEYS = {
  provider: 'map-and-posters:ai-provider',
  apiKey: 'map-and-posters:ai-api-key',
  model: 'map-and-posters:ai-model',
  endpoint: 'map-and-posters:ai-endpoint',
  googlePlacesKey: 'map-and-posters:google-places-key',
} as const

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
}

export const DEFAULT_ENDPOINTS: Record<AiProvider, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
}

export interface AiConfig {
  provider: AiProvider
  apiKey: string
  model: string
  endpoint: string
  googlePlacesKey: string
}

export interface TrackSample extends PointRef {
  index: number
  lat: number
  lon: number
  km: number
}

export interface GpxBounds {
  west: number
  south: number
  east: number
  north: number
}

export interface TrackPass {
  sampleIndex: number
  position: PointRef
  trackKm: number
  distanceKm: number
}

export interface GeocodedPlace {
  query: string
  name: string
  lat: number
  lon: number
  source: 'project' | 'google' | 'photon'
  existingPlaceId?: string
}

export interface ParsedDaySpec {
  dayNumber?: number
  kind: 'ride' | 'rest'
  name?: string
  endPlace?: string
  overnightPlace?: string
  passHint?: 'first' | 'second' | 'last' | number
}

export interface PlannedSplit {
  query: string
  resolved: GeocodedPlace | null
  candidates: TrackPass[]
  selectedPassIndex: number
  ambiguous: boolean
  isRouteEnd: boolean
  error?: string
}

export interface PlannedOvernight {
  query: string
  resolved: GeocodedPlace | null
  error?: string
}

export interface PlannedDay {
  id: string
  dayIndex: number
  kind: 'ride' | 'rest'
  name: string
  inferredRemainder: boolean
  startSampleIndex?: number
  endSampleIndex?: number
  km: number
  split?: PlannedSplit
  overnight?: PlannedOvernight
}

export interface AiSplitPlan {
  prompt: string
  totalKm: number
  totalSamples: number
  days: PlannedDay[]
  errors: string[]
  warnings: string[]
  canApply: boolean
}

const DAY_PALETTE = ['#aa4839', '#25678a', '#7760a2', '#167c79', '#a15513', '#8f4466', '#4e7040', '#4f5899']

function defaultStorage(): StorageLike | null {
  try {
    if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage
  } catch {
    // Restricted browser context
  }
  return null
}

function readKey(storage: StorageLike | null, key: string): string {
  if (!storage) return ''
  try {
    return storage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeKey(storage: StorageLike | null, key: string, value: string) {
  if (!storage) return
  try {
    if (value) storage.setItem(key, value)
    else storage.removeItem(key)
  } catch {
    // Ignore storage quota / private-mode failures
  }
}

export function validateEndpointUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Enter a valid HTTPS endpoint URL (or http://localhost for a local server).')
  }
  const isLocal = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new Error('Custom AI endpoints must use HTTPS (or http://localhost / http://127.0.0.1).')
  }
  return parsed.toString()
}

export function loadAiConfig(storage = defaultStorage()): AiConfig {
  const rawProvider = readKey(storage, AI_STORAGE_KEYS.provider)
  const provider: AiProvider = rawProvider === 'gemini' ? 'gemini' : 'openai'
  const model = readKey(storage, AI_STORAGE_KEYS.model).trim() || DEFAULT_MODELS[provider]
  let endpoint = ''
  try {
    endpoint = validateEndpointUrl(readKey(storage, AI_STORAGE_KEYS.endpoint))
  } catch {
    endpoint = ''
  }
  return {
    provider,
    apiKey: readKey(storage, AI_STORAGE_KEYS.apiKey).trim(),
    model,
    endpoint,
    googlePlacesKey: readKey(storage, AI_STORAGE_KEYS.googlePlacesKey).trim(),
  }
}

export function saveAiConfig(patch: Partial<AiConfig>, storage = defaultStorage()): AiConfig {
  const current = loadAiConfig(storage)
  const provider: AiProvider = patch.provider === 'gemini' ? 'gemini' : patch.provider === 'openai' ? 'openai' : current.provider
  const endpoint = patch.endpoint !== undefined ? validateEndpointUrl(patch.endpoint) : current.endpoint
  const rawModel = patch.model !== undefined ? patch.model.trim() : current.model
  const model = rawModel || DEFAULT_MODELS[provider]
  const next: AiConfig = {
    provider,
    apiKey: patch.apiKey !== undefined ? patch.apiKey.trim() : current.apiKey,
    model,
    endpoint,
    googlePlacesKey: patch.googlePlacesKey !== undefined ? patch.googlePlacesKey.trim() : current.googlePlacesKey,
  }
  writeKey(storage, AI_STORAGE_KEYS.provider, next.provider)
  writeKey(storage, AI_STORAGE_KEYS.apiKey, next.apiKey)
  writeKey(storage, AI_STORAGE_KEYS.model, next.model)
  writeKey(storage, AI_STORAGE_KEYS.endpoint, next.endpoint)
  writeKey(storage, AI_STORAGE_KEYS.googlePlacesKey, next.googlePlacesKey)
  return next
}

export function clearAiConfig(storage = defaultStorage()): void {
  for (const key of Object.values(AI_STORAGE_KEYS)) writeKey(storage, key, '')
}

export function collectRouteSamples(project: Project): { samples: TrackSample[], totalKm: number, bounds: GpxBounds | null } {
  const included = new Map(project.recordings.filter(r => r.included).map(r => [r.id, r]))
  const ridingRanges = combinedRanges(project.days.filter(d => !d.rest))
    .filter(r => included.has(r.recordingId))
  const samples: TrackSample[] = []
  let km = 0
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity

  for (const range of ridingRanges) {
    const line = included.get(range.recordingId)?.track[range.segment]
    if (!line) continue
    for (let i = range.start; i <= range.end && i < line.length; i++) {
      const pt = line[i]
      if (i > range.start) km += distance(line[i - 1], pt)
      west = Math.min(west, pt.lon)
      east = Math.max(east, pt.lon)
      south = Math.min(south, pt.lat)
      north = Math.max(north, pt.lat)
      samples.push({
        index: samples.length,
        recordingId: range.recordingId,
        segment: range.segment,
        point: i,
        lat: pt.lat,
        lon: pt.lon,
        km,
      })
    }
  }

  if (!samples.length) return { samples, totalKm: 0, bounds: null }
  return { samples, totalKm: km, bounds: { west, south, east, north } }
}

function paddedBounds(bounds: GpxBounds): GpxBounds {
  const latPad = Math.max(0.15, (bounds.north - bounds.south) * 0.15)
  const lonPad = Math.max(0.15, (bounds.east - bounds.west) * 0.15)
  return {
    west: Math.max(-180, bounds.west - lonPad),
    east: Math.min(180, bounds.east + lonPad),
    south: Math.max(-90, bounds.south - latPad),
    north: Math.min(90, bounds.north + latPad),
  }
}

function minDistanceToSamples(coords: Coordinates, samples: TrackSample[]): number {
  const target = { lat: coords.lat, lon: coords.lon, ele: null }
  let best = Infinity
  for (const s of samples) {
    const d = distance(target, { lat: s.lat, lon: s.lon, ele: null })
    if (d < best) best = d
  }
  return best
}

export function findTrackPasses(
  samples: TrackSample[],
  coords: Coordinates,
  options?: { maxSnapKm?: number, allowEndpoints?: boolean, separationKm?: number }
): TrackPass[] {
  if (!samples.length || !validCoordinates(coords.lat, coords.lon)) return []
  const maxSnapKm = options?.maxSnapKm ?? 25
  const allowEndpoints = options?.allowEndpoints ?? false
  const separationKm = options?.separationKm ?? 1.0
  const target = { lat: coords.lat, lon: coords.lon, ele: null }

  const ds = samples.map(s => distance(target, { lat: s.lat, lon: s.lon, ele: null }))
  let closest = Infinity
  for (const d of ds) if (d < closest) closest = d
  if (!Number.isFinite(closest) || closest > maxSnapKm) return []

  const tolerance = Math.min(2.5, Math.max(0.5, closest * 0.5))
  const limit = closest + tolerance

  // 1. Collect all local distance minima within the tolerance band
  const rawMinima: number[] = []
  for (let i = 0; i < ds.length; i++) {
    if (ds[i] > limit) continue
    const first = i
    while (i + 1 < ds.length && Math.abs(ds[i + 1] - ds[first]) < 1e-6) i++
    const before = first === 0 ? Infinity : ds[first - 1]
    const after = i === ds.length - 1 ? Infinity : ds[i + 1]
    if (ds[first] <= before && ds[first] <= after) {
      rawMinima.push(first)
    }
  }
  if (!rawMinima.length) return []

  // 2. Cluster consecutive local minima that never genuinely leave the neighborhood (GPS jitter / switchbacks)
  const clustered: number[] = [rawMinima[0]]
  for (let k = 1; k < rawMinima.length; k++) {
    const prevIdx = clustered[clustered.length - 1]
    const currIdx = rawMinima[k]
    let maxBetween = 0
    for (let j = prevIdx; j <= currIdx; j++) {
      if (ds[j] > maxBetween) maxBetween = ds[j]
    }
    if (maxBetween <= Math.max(ds[prevIdx], ds[currIdx]) + separationKm) {
      if (ds[currIdx] < ds[prevIdx]) clustered[clustered.length - 1] = currIdx
    } else {
      clustered.push(currIdx)
    }
  }

  // 3. Optionally exclude exact route start/end when choosing interior split points
  const filtered = allowEndpoints
    ? clustered
    : clustered.filter(idx => idx > 0 && idx < samples.length - 1)

  return filtered.map(idx => {
    const s = samples[idx]
    return {
      sampleIndex: idx,
      position: { recordingId: s.recordingId, segment: s.segment, point: s.point },
      trackKm: s.km,
      distanceKm: ds[idx],
    }
  })
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  } catch {
    return false
  }
}

async function fetchJson(url: string, init: RequestInit | undefined, fetchImpl: typeof fetch, label: string): Promise<unknown> {
  if (isOffline()) {
    throw new Error('You appear to be offline. You can still split days manually on the map above.')
  }
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch {
    throw new Error(`Could not reach the ${label} service. Check your connection or split days manually.`)
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${label} rejected the API key (HTTP ${response.status}). Check your key in Settings.`)
    }
    if (response.status === 429) {
      throw new Error(`${label} rate limit reached (HTTP 429). Wait a moment and try again.`)
    }
    throw new Error(`${label} request failed (HTTP ${response.status}).`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error(`${label} returned invalid JSON.`)
  }
}

export async function geocodePlace(
  query: string,
  project: Project,
  bounds: GpxBounds,
  samples: TrackSample[],
  options?: { googlePlacesKey?: string, fetchImpl?: typeof fetch }
): Promise<GeocodedPlace | null> {
  const trimmed = query.trim()
  if (!trimmed) return null

  // 1. Reuse verified coordinates from existing project places / GPX waypoints if exact name matches
  const normalized = normalizeText(trimmed)
  const existing = project.places.find(p => normalizeText(p.name) === normalized && validCoordinates(p.lat, p.lon))
  if (existing) {
    return {
      query: trimmed,
      name: existing.name,
      lat: existing.lat,
      lon: existing.lon,
      source: 'project',
      existingPlaceId: existing.id,
    }
  }

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch
  const box = paddedBounds(bounds)
  const googleKey = options?.googlePlacesKey?.trim() || ''

  // 2. Optional Google Places API v1 text search biased to GPX bounding box
  if (googleKey) {
    try {
      const data = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleKey,
          'X-Goog-FieldMask': 'places.displayName,places.location',
        },
        body: JSON.stringify({
          textQuery: trimmed,
          maxResultCount: 5,
          locationBias: {
            rectangle: {
              low: { latitude: box.south, longitude: box.west },
              high: { latitude: box.north, longitude: box.east },
            },
          },
        }),
      }, fetchImpl, 'Google Places') as { places?: Array<{ displayName?: { text?: string }, location?: { latitude?: number, longitude?: number } }> }

      const candidates = (data.places ?? [])
        .map(p => ({
          name: p.displayName?.text?.trim() || trimmed,
          lat: Number(p.location?.latitude),
          lon: Number(p.location?.longitude),
        }))
        .filter(c => validCoordinates(c.lat, c.lon))

      if (candidates.length) {
        candidates.sort((a, b) => minDistanceToSamples(a, samples) - minDistanceToSamples(b, samples))
        const best = candidates[0]
        return { query: trimmed, name: best.name, lat: best.lat, lon: best.lon, source: 'google' }
      }
    } catch {
      // Fall through cleanly to free OSM Photon fallback
    }
  }

  // 3. Default / fallback: OSM Photon constrained by GPX bbox
  const centerLat = ((box.south + box.north) / 2).toFixed(5)
  const centerLon = ((box.west + box.east) / 2).toFixed(5)
  const bboxParam = [box.west, box.south, box.east, box.north].map(n => n.toFixed(5)).join(',')
  const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(trimmed)}&limit=5&bbox=${encodeURIComponent(bboxParam)}&lat=${centerLat}&lon=${centerLon}`

  const photonData = await fetchJson(photonUrl, undefined, fetchImpl, 'geocoding') as {
    features?: Array<{
      geometry?: { coordinates?: unknown[] }
      properties?: { name?: string, city?: string, town?: string, village?: string }
    }>
  }

  const features = (photonData.features ?? [])
    .map(f => {
      const coords = f.geometry?.coordinates
      const lon = Number(coords?.[0])
      const lat = Number(coords?.[1])
      const name = f.properties?.name || f.properties?.city || f.properties?.town || f.properties?.village || trimmed
      return { name: String(name).trim() || trimmed, lat, lon }
    })
    .filter(c => validCoordinates(c.lat, c.lon))

  if (!features.length) return null
  features.sort((a, b) => minDistanceToSamples(a, samples) - minDistanceToSamples(b, samples))
  const best = features[0]
  return { query: trimmed, name: best.name, lat: best.lat, lon: best.lon, source: 'photon' }
}

const SYSTEM_PROMPT = [
  'You extract structured multi-day itinerary splits from a rider\'s natural-language trip description.',
  'Return ONLY a valid JSON object matching this exact schema:',
  '{"days":[{"dayNumber":1,"kind":"ride"|"rest","name":"optional short label","endPlace":"town/stop name where this riding day finished","overnightPlace":"town/stop name where the rider stayed overnight","passHint":"first"|"second"|"last"|1|2}]}',
  'Rules:',
  '- Do NOT include latitude, longitude, or numeric coordinates; place names are geocoded separately.',
  '- Use kind="rest" for rest days or zero-riding days, and kind="ride" for travel/riding days.',
  '- If a riding day finishes in a town (e.g. "Day 1 finished in Pai"), set endPlace to "Pai" and overnightPlace to "Pai" unless the user specified a different overnight stop.',
  '- If a rest day is in a town (e.g. "Day 2 was a rest day in Pai"), set kind="rest", name="Pai", and overnightPlace="Pai". Omit endPlace on rest days.',
  '- Only set passHint if the user explicitly mentions visiting a place on the first/second/return/last pass.',
  '- Keep days in chronological order.',
].join('\n')

function stripJsonFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

function normalizePassHint(value: unknown): ParsedDaySpec['passHint'] | undefined {
  if (value === 'first' || value === 'second' || value === 'last') return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  return undefined
}

function sanitizeParsedDays(raw: unknown): ParsedDaySpec[] {
  const obj = raw as { days?: unknown }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.days) || !obj.days.length) {
    throw new Error('AI response did not contain a valid list of days. Try rephrasing your itinerary.')
  }
  const result: ParsedDaySpec[] = []
  for (const item of obj.days) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const rawKind = String(rec.kind ?? '').trim().toLowerCase()
    const kind: 'ride' | 'rest' = rawKind === 'rest' || rawKind === 'rest_day' || rawKind === 'rest day' ? 'rest' : 'ride'
    const spec: ParsedDaySpec = { kind }
    if (typeof rec.dayNumber === 'number' && Number.isInteger(rec.dayNumber) && rec.dayNumber > 0) {
      spec.dayNumber = rec.dayNumber
    }
    if (typeof rec.name === 'string' && rec.name.trim()) spec.name = rec.name.trim().slice(0, 80)
    if (kind === 'ride' && typeof rec.endPlace === 'string' && rec.endPlace.trim()) {
      spec.endPlace = rec.endPlace.trim().slice(0, 120)
    }
    if (typeof rec.overnightPlace === 'string' && rec.overnightPlace.trim()) {
      spec.overnightPlace = rec.overnightPlace.trim().slice(0, 120)
    }
    const hint = normalizePassHint(rec.passHint)
    if (hint !== undefined) spec.passHint = hint
    // Explicitly omit any LLM-supplied lat/lon/coordinates fields
    result.push(spec)
  }
  if (!result.length) {
    throw new Error('AI could not identify any days from that description.')
  }
  return result
}

function resolveAiEndpoint(config: AiConfig): { url: string, isLocal: boolean } {
  const custom = validateEndpointUrl(config.endpoint)
  const model = config.model.trim() || DEFAULT_MODELS[config.provider]
  const url = custom || DEFAULT_ENDPOINTS[config.provider].replace('{model}', encodeURIComponent(model))
  const parsed = new URL(url)
  const isLocal = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  return { url, isLocal }
}

export async function parseNaturalItinerary(
  prompt: string,
  project: Project,
  config: AiConfig,
  options?: { fetchImpl?: typeof fetch }
): Promise<ParsedDaySpec[]> {
  const cleanPrompt = prompt.trim()
  if (!cleanPrompt) throw new Error('Describe your days first (for example: "Day 1 finished in Pai, Day 2 rest in Pai").')

  const { url, isLocal } = resolveAiEndpoint(config)
  const apiKey = config.apiKey.trim()
  if (!apiKey && !isLocal) {
    throw new Error('Add an AI API key in Settings (stored only in this browser) to ask AI.')
  }

  const { totalKm, bounds } = collectRouteSamples(project)
  const waypointNames = project.places.slice(0, 20).map(p => p.name).filter(Boolean)
  const contextParts = [
    `Recorded route distance: ${totalKm.toFixed(1)} km across ${project.recordings.filter(r => r.included).length} GPX file(s).`,
  ]
  if (bounds) {
    contextParts.push(
      `Approximate region: lat ${bounds.south.toFixed(1)}..${bounds.north.toFixed(1)}, lon ${bounds.west.toFixed(1)}..${bounds.east.toFixed(1)}.`
    )
  }
  if (waypointNames.length) {
    contextParts.push(`Existing waypoints: ${waypointNames.join(', ')}.`)
  }
  const userMessage = `${contextParts.join(' ')}\n\nRider itinerary:\n${cleanPrompt}`

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch
  const model = config.model.trim() || DEFAULT_MODELS[config.provider]

  let rawText = ''
  if (config.provider === 'gemini') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['x-goog-api-key'] = apiKey
    const data = await fetchJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    }, fetchImpl, 'Gemini AI') as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    rawText = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
  } else {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const data = await fetchJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    }, fetchImpl, 'AI') as { choices?: Array<{ message?: { content?: string } }> }
    rawText = data.choices?.[0]?.message?.content ?? ''
  }

  if (!rawText.trim()) {
    throw new Error('AI returned an empty response. Try again or split days manually.')
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(stripJsonFence(rawText))
  } catch {
    throw new Error('AI returned unreadable output instead of JSON. Try rephrasing your itinerary.')
  }
  return sanitizeParsedDays(parsedJson)
}

function chooseDefaultPassIndex(candidates: TrackPass[], prevSplitIndex: number, hint?: ParsedDaySpec['passHint']): number {
  if (!candidates.length) return 0
  if (hint === 'last') return candidates.length - 1
  if (hint === 'second' && candidates.length >= 2) return 1
  if (hint === 'first') return 0
  if (typeof hint === 'number' && hint >= 1 && hint <= candidates.length) return hint - 1
  const nextValid = candidates.findIndex(c => c.sampleIndex > prevSplitIndex)
  return nextValid >= 0 ? nextValid : 0
}

function recomputePlan(input: AiSplitPlan): AiSplitPlan {
  const days: PlannedDay[] = input.days.map(d => ({
    ...d,
    split: d.split ? { ...d.split, candidates: d.split.candidates.map(c => ({ ...c, position: { ...c.position } })) } : undefined,
    overnight: d.overnight ? { ...d.overnight } : undefined,
  }))
  const errors: string[] = []
  const warnings: string[] = []

  let prevSplitIndex = 0
  let prevKm = 0

  days.forEach((day, idx) => {
    day.dayIndex = idx + 1
    if (day.kind === 'rest') {
      day.km = 0
      day.startSampleIndex = undefined
      day.endSampleIndex = undefined
      if (day.overnight?.error) warnings.push(`Day ${day.dayIndex}: ${day.overnight.error}`)
      return
    }

    const split = day.split
    if (split) {
      if (split.error) {
        errors.push(`Day ${day.dayIndex}: ${split.error}`)
        day.km = 0
        return
      }
      if (split.isRouteEnd) {
        day.startSampleIndex = prevSplitIndex
        day.endSampleIndex = Math.max(0, input.totalSamples - 1)
        day.km = Math.max(0, input.totalKm - prevKm)
        prevSplitIndex = day.endSampleIndex
        prevKm = input.totalKm
        return
      }
      const chosen = split.candidates[split.selectedPassIndex]
      if (!chosen) {
        const msg = `Could not match "${split.query}" to a point on the GPX route.`
        split.error = msg
        errors.push(`Day ${day.dayIndex}: ${msg}`)
        day.km = 0
        return
      }
      if (chosen.sampleIndex <= prevSplitIndex) {
        errors.push(`Day ${day.dayIndex} ("${split.resolved?.name || split.query}" at ${chosen.trackKm.toFixed(1)} km) is earlier than or equal to the previous split. Pick a later pass or revise the order.`)
      }
      if (chosen.sampleIndex >= input.totalSamples - 1) {
        errors.push(`Day ${day.dayIndex} ("${split.resolved?.name || split.query}") lands on the final point of the route and cannot be followed by another riding day.`)
      }
      if (split.ambiguous) {
        warnings.push(`"${split.resolved?.name || split.query}" is passed ${split.candidates.length} times — confirm which pass ends Day ${day.dayIndex}.`)
      }
      day.startSampleIndex = prevSplitIndex
      day.endSampleIndex = chosen.sampleIndex
      day.km = Math.max(0, chosen.trackKm - prevKm)
      prevSplitIndex = chosen.sampleIndex
      prevKm = chosen.trackKm
    } else {
      day.startSampleIndex = prevSplitIndex
      day.endSampleIndex = Math.max(0, input.totalSamples - 1)
      day.km = Math.max(0, input.totalKm - prevKm)
      prevSplitIndex = day.endSampleIndex
      prevKm = input.totalKm
    }

    if (day.overnight?.error && day.overnight.query !== day.split?.query) {
      warnings.push(`Day ${day.dayIndex}: ${day.overnight.error}`)
    }
  })

  const canApply = errors.length === 0 && days.length > 0 && days.some(d => d.kind === 'ride')
  return {
    ...input,
    days,
    errors,
    warnings,
    canApply,
  }
}

export async function buildAiSplitPlan(
  prompt: string,
  project: Project,
  config: AiConfig,
  options?: { fetchImpl?: typeof fetch, maxSnapKm?: number }
): Promise<AiSplitPlan> {
  const { samples, totalKm, bounds } = collectRouteSamples(project)
  if (samples.length < 3 || !bounds) {
    throw new Error('Include a GPX track with at least 3 points before asking AI to split days.')
  }

  const parsedDays = await parseNaturalItinerary(prompt, project, config, { fetchImpl: options?.fetchImpl })

  // Cache geocoding results per normalized place query within this single plan build
  const geoCache = new Map<string, GeocodedPlace | null>()
  async function resolveName(name: string): Promise<GeocodedPlace | null> {
    const key = normalizeText(name)
    if (!geoCache.has(key)) {
      const resolved = await geocodePlace(name, project, bounds!, samples, {
        googlePlacesKey: config.googlePlacesKey,
        fetchImpl: options?.fetchImpl,
      })
      geoCache.set(key, resolved)
    }
    return geoCache.get(key) ?? null
  }

  const maxSnapKm = options?.maxSnapKm ?? 25
  const lastRideSpecIdx = parsedDays.reduce((acc, d, i) => (d.kind === 'ride' ? i : acc), -1)

  const plannedDays: PlannedDay[] = []
  let prevSplitIndex = 0
  let hasUnallocatedTail = true

  for (let i = 0; i < parsedDays.length; i++) {
    const spec = parsedDays[i]
    const id = crypto.randomUUID()

    if (spec.kind === 'rest') {
      let overnight: PlannedOvernight | undefined
      const overnightQuery = spec.overnightPlace || spec.name
      if (overnightQuery) {
        const resolved = await resolveName(overnightQuery)
        overnight = resolved
          ? { query: overnightQuery, resolved }
          : { query: overnightQuery, resolved: null, error: `Could not locate "${overnightQuery}" near this route.` }
      }
      plannedDays.push({
        id,
        dayIndex: plannedDays.length + 1,
        kind: 'rest',
        name: spec.name || overnight?.resolved?.name || 'Rest day',
        inferredRemainder: false,
        km: 0,
        overnight,
      })
      continue
    }

    // Riding day
    let split: PlannedSplit | undefined
    let overnight: PlannedOvernight | undefined

    if (spec.endPlace) {
      const resolved = await resolveName(spec.endPlace)
      if (!resolved) {
        split = {
          query: spec.endPlace,
          resolved: null,
          candidates: [],
          selectedPassIndex: 0,
          ambiguous: false,
          isRouteEnd: false,
          error: `Could not find "${spec.endPlace}" near this GPX route.`,
        }
      } else {
        const interiorPasses = findTrackPasses(samples, resolved, { maxSnapKm, allowEndpoints: false })
        const allPasses = findTrackPasses(samples, resolved, { maxSnapKm, allowEndpoints: true })
        const isLastSpecifiedRide = i === lastRideSpecIdx
        const lastPass = allPasses[allPasses.length - 1]
        const endsAtRouteFinish = Boolean(
          isLastSpecifiedRide &&
          lastPass &&
          lastPass.sampleIndex > prevSplitIndex &&
          (lastPass.sampleIndex === samples.length - 1 || totalKm - lastPass.trackKm <= Math.max(0.5, totalKm * 0.02)) &&
          interiorPasses.length <= 1
        )

        if (endsAtRouteFinish) {
          split = {
            query: spec.endPlace,
            resolved,
            candidates: [lastPass],
            selectedPassIndex: 0,
            ambiguous: false,
            isRouteEnd: true,
          }
          hasUnallocatedTail = false
        } else if (!interiorPasses.length) {
          const nearEnd = Boolean(isLastSpecifiedRide && lastPass && lastPass.sampleIndex === samples.length - 1)
          if (nearEnd) {
            split = {
              query: spec.endPlace,
              resolved,
              candidates: [lastPass],
              selectedPassIndex: 0,
              ambiguous: false,
              isRouteEnd: true,
            }
            hasUnallocatedTail = false
          } else {
            split = {
              query: spec.endPlace,
              resolved,
              candidates: [],
              selectedPassIndex: 0,
              ambiguous: false,
              isRouteEnd: false,
              error: `"${resolved.name}" is too far from the recorded GPX route (over ${maxSnapKm} km away) or at the start point.`,
            }
          }
        } else {
          const selectedPassIndex = chooseDefaultPassIndex(interiorPasses, prevSplitIndex, spec.passHint)
          split = {
            query: spec.endPlace,
            resolved,
            candidates: interiorPasses,
            selectedPassIndex,
            ambiguous: interiorPasses.length > 1,
            isRouteEnd: false,
          }
          prevSplitIndex = interiorPasses[selectedPassIndex].sampleIndex
          hasUnallocatedTail = true
        }
      }
    } else if (i === lastRideSpecIdx) {
      hasUnallocatedTail = false
    }

    const overnightQuery = spec.overnightPlace || spec.endPlace
    if (overnightQuery) {
      const resolved = split?.resolved && normalizeText(overnightQuery) === normalizeText(split.query)
        ? split.resolved
        : await resolveName(overnightQuery)
      overnight = resolved
        ? { query: overnightQuery, resolved }
        : { query: overnightQuery, resolved: null, error: `Could not locate "${overnightQuery}" near this route.` }
    }

    plannedDays.push({
      id,
      dayIndex: plannedDays.length + 1,
      kind: 'ride',
      name: spec.name || '',
      inferredRemainder: false,
      km: 0,
      split,
      overnight,
    })
  }

  // If the user's last riding split left remaining route geometry, append an explicit remainder day so no track is dropped
  if (hasUnallocatedTail) {
    plannedDays.push({
      id: crypto.randomUUID(),
      dayIndex: plannedDays.length + 1,
      kind: 'ride',
      name: '',
      inferredRemainder: true,
      km: 0,
    })
  }

  return recomputePlan({
    prompt: prompt.trim(),
    totalKm,
    totalSamples: samples.length,
    days: plannedDays,
    errors: [],
    warnings: [],
    canApply: false,
  })
}

export function selectPlanPass(plan: AiSplitPlan, dayId: string, candidateIndex: number): AiSplitPlan {
  const nextDays = plan.days.map(d => {
    if (d.id !== dayId || !d.split) return d
    const bounded = Math.max(0, Math.min(d.split.candidates.length - 1, candidateIndex))
    return { ...d, split: { ...d.split, selectedPassIndex: bounded } }
  })
  return recomputePlan({ ...plan, days: nextDays })
}

function findOrCreatePlace(project: Project, geo: GeocodedPlace): Place {
  if (geo.existingPlaceId) {
    const byId = project.places.find(p => p.id === geo.existingPlaceId)
    if (byId) {
      byId.visible = true
      return byId
    }
  }
  const targetName = normalizeText(geo.name)
  const existing = project.places.find(p =>
    normalizeText(p.name) === targetName &&
    distance({ lat: p.lat, lon: p.lon, ele: null }, { lat: geo.lat, lon: geo.lon, ele: null }) < 2
  )
  if (existing) {
    existing.visible = true
    return existing
  }
  return addPlace(project, geo.name, { lat: geo.lat, lon: geo.lon }, true, 'Place')
}

export function applyAiSplitPlan(project: Project, rawPlan: AiSplitPlan): Project {
  const plan = recomputePlan(rawPlan)
  if (!plan.canApply) {
    throw new Error(plan.errors[0] || 'Resolve plan issues before applying.')
  }

  const includedIds = new Set(project.recordings.filter(r => r.included).map(r => r.id))
  const allRanges = combinedRanges(project.days.filter(d => !d.rest))
    .filter(r => includedIds.has(r.recordingId))
  if (!allRanges.length) {
    throw new Error('No included GPX track points are available to split.')
  }

  const oldDayIds = new Set(project.days.map(d => d.id))
  const staged: { day: Day, overnight?: GeocodedPlace }[] = []
  let remaining: Range[] = allRanges

  const colorFor = (idx: number) => DAY_PALETTE[idx % DAY_PALETTE.length]

  for (const pd of plan.days) {
    const color = colorFor(staged.length)
    let day: Day
    if (pd.kind === 'rest') {
      day = {
        id: crypto.randomUUID(),
        name: pd.name.trim() || 'Rest day',
        color,
        rest: true,
        ranges: [],
      }
    } else if (pd.split && !pd.split.isRouteEnd) {
      const chosen = pd.split.candidates[pd.split.selectedPassIndex]
      const [before, after] = splitRanges(remaining, chosen.position)
      day = {
        id: crypto.randomUUID(),
        name: pd.name.trim(),
        color,
        rest: false,
        ranges: before,
      }
      remaining = after
    } else {
      if (!remaining.length) {
        throw new Error(`No route track remained for Day ${pd.dayIndex}.`)
      }
      day = {
        id: crypto.randomUUID(),
        name: pd.name.trim(),
        color,
        rest: false,
        ranges: remaining,
      }
      remaining = []
    }

    staged.push({ day, overnight: pd.overnight?.resolved ?? undefined })
  }

  // Commit atomically only after every split succeeded
  const newDays: Day[] = []
  const newVisits: Visit[] = []
  for (const { day, overnight } of staged) {
    newDays.push(day)
    if (overnight) {
      const place = findOrCreatePlace(project, overnight)
      const endRange = day.rest ? undefined : day.ranges[day.ranges.length - 1]
      const position: Visit['position'] = endRange
        ? { recordingId: endRange.recordingId, segment: endRange.segment, point: endRange.end }
        : undefined
      newVisits.push({
        id: crypto.randomUUID(),
        placeId: place.id,
        dayId: day.id,
        overnight: true,
        position,
      })
    }
  }

  project.days = newDays
  project.manualOrder = true
  project.visits = project.visits.filter(v => !oldDayIds.has(v.dayId)).concat(newVisits)

  // Clean up orphaned photo & output day references so backup/restore schema v1 always validates
  let hasTripHero = project.photos.some(p => p.dayId === '' && p.hero)
  for (const photo of project.photos) {
    if (!photo.dayId || !oldDayIds.has(photo.dayId)) continue
    photo.dayId = ''
    if (photo.hero && hasTripHero) photo.hero = false
    else if (photo.hero) hasTripHero = true
  }

  const out = project.output
  const removedKeys = new Set(Array.from(oldDayIds, id => 'day:' + id))
  out.groups = out.groups.filter(group => {
    group.dayIds = group.dayIds.filter(id => !oldDayIds.has(id))
    if (group.dayIds.length) return true
    removedKeys.add('group:' + group.id)
    return false
  })
  if (removedKeys.has(out.active)) out.active = 'trip'
  out.selected = out.selected.filter(key => !removedKeys.has(key))
  for (const settings of [out.labels, out.placeVisibility, out.placeText]) {
    if (!settings) continue
    for (const key of removedKeys) delete settings[key]
  }

  return project
}
