import { validCoordinates, type Coordinates } from './assets'
import { distance, type Track } from './track'

export const GOOGLE_PLACES_KEY_STORAGE = 'map-and-posters:google-places-key'

const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/'
const GOOGLE_AUTOCOMPLETE_ENDPOINT = 'https://places.googleapis.com/v1/places:autocomplete'
const GOOGLE_DETAILS_BASE = 'https://places.googleapis.com/v1/places/'
const OFFLINE_ERROR = 'Place search unavailable offline. Paste coordinates or a map link instead.'

export type GeoBounds = {
  south: number
  west: number
  north: number
  east: number
}

export type PlaceProvider = 'google' | 'photon'

export interface PlaceSuggestion {
  id: string
  name: string
  subtitle: string
  coords?: Coordinates
  provider: PlaceProvider
  placeId?: string
}

export interface PlaceResult {
  name: string
  subtitle: string
  coords: Coordinates
  provider: PlaceProvider
}

export interface SearchOptions {
  bounds?: GeoBounds | null
  apiKey?: string
  limit?: number
  sessionToken?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface SearchOutcome {
  provider: PlaceProvider
  suggestions: PlaceSuggestion[]
  error?: string
  aborted?: boolean
}

export interface ResolveOptions {
  apiKey?: string
  sessionToken?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface ResolveOutcome {
  place?: PlaceResult
  error?: string
  aborted?: boolean
}

export interface RouteSnapCandidate {
  index: number
  km: number
  distanceKm: number
}

function roundCoord(value: number): number {
  return Number(value.toFixed(6))
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError')
}

export function getGooglePlacesKey(storage?: Pick<Storage, 'getItem'> | null): string {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage
    return store?.getItem(GOOGLE_PLACES_KEY_STORAGE)?.trim() || ''
  } catch {
    return ''
  }
}

export function setGooglePlacesKey(key: string, storage?: Pick<Storage, 'setItem' | 'removeItem'> | null): string {
  const trimmed = key.trim()
  try {
    const store = storage === undefined ? globalThis.localStorage : storage
    if (!store) return trimmed
    if (trimmed) store.setItem(GOOGLE_PLACES_KEY_STORAGE, trimmed)
    else store.removeItem(GOOGLE_PLACES_KEY_STORAGE)
  } catch {
    // Ignore blocked/private storage so offline and manual flows continue seamlessly.
  }
  return trimmed
}

export function trackBounds(tracks: ReadonlyArray<Track>, minPadDeg = 0.25): GeoBounds | null {
  let south = Infinity
  let north = -Infinity
  let west = Infinity
  let east = -Infinity
  let count = 0
  for (const track of tracks) {
    for (const segment of track) {
      for (const point of segment) {
        if (!validCoordinates(point.lat, point.lon)) continue
        south = Math.min(south, point.lat)
        north = Math.max(north, point.lat)
        west = Math.min(west, point.lon)
        east = Math.max(east, point.lon)
        count++
      }
    }
  }
  if (!count || east - west > 180) return null
  const padLat = Math.max(minPadDeg, (north - south) * 0.25)
  const padLon = Math.max(minPadDeg, (east - west) * 0.25)
  return {
    south: roundCoord(Math.max(-90, south - padLat)),
    west: roundCoord(Math.max(-180, west - padLon)),
    north: roundCoord(Math.min(90, north + padLat)),
    east: roundCoord(Math.min(180, east + padLon)),
  }
}

type PhotonFeature = {
  geometry?: { coordinates?: unknown }
  properties?: Record<string, unknown>
}

function parsePhotonFeatures(data: unknown, limit: number): PlaceSuggestion[] {
  const features = Array.isArray((data as { features?: unknown })?.features)
    ? (data as { features: PhotonFeature[] }).features
    : []
  const suggestions: PlaceSuggestion[] = []
  const seen = new Set<string>()
  for (let i = 0; i < features.length && suggestions.length < limit; i++) {
    const coords = features[i]?.geometry?.coordinates
    if (!Array.isArray(coords) || coords.length < 2) continue
    const lon = Number(coords[0])
    const lat = Number(coords[1])
    if (!validCoordinates(lat, lon)) continue
    const props = features[i]?.properties || {}
    const str = (key: string) => typeof props[key] === 'string' ? props[key].trim() : ''
    const street = str('street')
    const housenumber = str('housenumber')
    const streetLine = street ? (housenumber ? `${street} ${housenumber}` : street) : ''
    const name = str('name') || str('city') || streetLine || str('county') || str('state') || str('country')
    if (!name) continue

    const parts: string[] = []
    const lowerSeen = new Set<string>([name.toLowerCase()])
    for (const part of [streetLine, str('city'), str('county'), str('state'), str('country')]) {
      if (!part) continue
      const key = part.toLowerCase()
      if (lowerSeen.has(key)) continue
      lowerSeen.add(key)
      parts.push(part)
    }
    const subtitle = parts.join(', ')
    const dedupeKey = `${name.toLowerCase()}|${lat.toFixed(4)},${lon.toFixed(4)}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    const osmType = str('osm_type') || 'p'
    const osmId = props.osm_id !== undefined ? String(props.osm_id) : String(i)
    suggestions.push({
      id: `photon:${osmType}:${osmId}:${lat.toFixed(5)},${lon.toFixed(5)}`,
      name,
      subtitle,
      coords: { lat, lon },
      provider: 'photon',
    })
  }
  return suggestions
}

async function queryPhoton(
  query: string,
  limit: number,
  bounds: GeoBounds | null | undefined,
  withBbox: boolean,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<{ suggestions: PlaceSuggestion[], error?: string }> {
  const url = new URL(PHOTON_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))
  if (bounds) {
    url.searchParams.set('lat', String(roundCoord((bounds.south + bounds.north) / 2)))
    url.searchParams.set('lon', String(roundCoord((bounds.west + bounds.east) / 2)))
    if (withBbox) {
      url.searchParams.set('bbox', [bounds.west, bounds.south, bounds.east, bounds.north].map(roundCoord).join(','))
    }
  }
  const response = await fetchFn(url.toString(), { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) {
    return {
      suggestions: [],
      error: response.status === 429
        ? 'Place search rate limit reached. Try again or enter coordinates manually.'
        : 'Place search returned an error. Paste coordinates or a map link instead.',
    }
  }
  const data = await response.json()
  return { suggestions: parsePhotonFeatures(data, limit) }
}

function googleHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return 'Google Places key was rejected. Check your key or clear it to use OpenStreetMap search.'
  }
  if (status === 429) {
    return 'Google Places rate limit reached. Try again or enter coordinates manually.'
  }
  return 'Place search returned an error. Paste coordinates or a map link instead.'
}

type GoogleAutocompleteItem = {
  placePrediction?: {
    placeId?: string
    text?: { text?: string }
    structuredFormat?: {
      mainText?: { text?: string }
      secondaryText?: { text?: string }
    }
  }
}

export async function searchPlaces(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
  const trimmed = query.trim()
  const key = options.apiKey !== undefined ? options.apiKey.trim() : getGooglePlacesKey()
  const provider: PlaceProvider = key ? 'google' : 'photon'
  if (options.signal?.aborted) return { provider, suggestions: [], aborted: true }
  if (trimmed.length < 2) return { provider, suggestions: [] }

  const fetchFn = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    return { provider, suggestions: [], error: OFFLINE_ERROR }
  }
  const limit = Math.max(1, Math.min(10, options.limit ?? 5))

  try {
    if (provider === 'google') {
      const body: Record<string, unknown> = { input: trimmed }
      if (options.sessionToken) body.sessionToken = options.sessionToken
      if (options.bounds) {
        body.locationBias = {
          rectangle: {
            low: { latitude: options.bounds.south, longitude: options.bounds.west },
            high: { latitude: options.bounds.north, longitude: options.bounds.east },
          },
        }
      }
      const response = await fetchFn(GOOGLE_AUTOCOMPLETE_ENDPOINT, {
        method: 'POST',
        signal: options.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.text',
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        return { provider, suggestions: [], error: googleHttpError(response.status) }
      }
      const data = await response.json() as { suggestions?: GoogleAutocompleteItem[] }
      const raw = Array.isArray(data?.suggestions) ? data.suggestions : []
      const suggestions: PlaceSuggestion[] = []
      for (const item of raw) {
        if (suggestions.length >= limit) break
        const pred = item?.placePrediction
        const placeId = typeof pred?.placeId === 'string' ? pred.placeId.trim() : ''
        if (!placeId) continue
        const mainText = pred?.structuredFormat?.mainText?.text?.trim() || ''
        const secondaryText = pred?.structuredFormat?.secondaryText?.text?.trim() || ''
        const fullText = pred?.text?.text?.trim() || ''
        const name = mainText || fullText
        if (!name) continue
        suggestions.push({
          id: `google:${placeId}`,
          name,
          subtitle: secondaryText,
          provider: 'google',
          placeId,
        })
      }
      return { provider, suggestions }
    }

    const bounded = await queryPhoton(trimmed, limit, options.bounds, Boolean(options.bounds), fetchFn, options.signal)
    if (bounded.error || bounded.suggestions.length > 0 || !options.bounds) {
      return { provider, ...bounded }
    }
    if (options.signal?.aborted) return { provider, suggestions: [], aborted: true }
    const broad = await queryPhoton(trimmed, limit, options.bounds, false, fetchFn, options.signal)
    return { provider, ...broad }
  } catch (error) {
    if (isAbortError(error, options.signal)) return { provider, suggestions: [], aborted: true }
    return { provider, suggestions: [], error: OFFLINE_ERROR }
  }
}

export async function resolvePlace(suggestion: PlaceSuggestion, options: ResolveOptions = {}): Promise<ResolveOutcome> {
  if (suggestion.coords && validCoordinates(suggestion.coords.lat, suggestion.coords.lon)) {
    return {
      place: {
        name: suggestion.name,
        subtitle: suggestion.subtitle,
        coords: suggestion.coords,
        provider: suggestion.provider,
      },
    }
  }
  if (options.signal?.aborted) return { aborted: true }
  if (suggestion.provider !== 'google' || !suggestion.placeId) {
    return { error: 'Could not determine coordinates for this place.' }
  }
  const key = options.apiKey !== undefined ? options.apiKey.trim() : getGooglePlacesKey()
  if (!key) {
    return { error: 'Google Places key is missing. Paste coordinates or a map link instead.' }
  }
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') return { error: OFFLINE_ERROR }

  try {
    const url = new URL(GOOGLE_DETAILS_BASE + encodeURIComponent(suggestion.placeId))
    if (options.sessionToken) url.searchParams.set('sessionToken', options.sessionToken)
    const response = await fetchFn(url.toString(), {
      method: 'GET',
      signal: options.signal,
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'displayName,formattedAddress,location',
      },
    })
    if (!response.ok) return { error: googleHttpError(response.status) }
    const data = await response.json() as {
      displayName?: { text?: string }
      formattedAddress?: string
      location?: { latitude?: number, longitude?: number }
    }
    const lat = Number(data?.location?.latitude)
    const lon = Number(data?.location?.longitude)
    if (!validCoordinates(lat, lon)) {
      return { error: 'Place details did not include valid coordinates. Paste coordinates manually.' }
    }
    return {
      place: {
        name: suggestion.name || data?.displayName?.text?.trim() || 'Unnamed place',
        subtitle: suggestion.subtitle || data?.formattedAddress?.trim() || '',
        coords: { lat, lon },
        provider: 'google',
      },
    }
  } catch (error) {
    if (isAbortError(error, options.signal)) return { aborted: true }
    return { error: OFFLINE_ERROR }
  }
}

export function snapPlaceToRoute(
  samples: ReadonlyArray<{ lat: number, lon: number, km: number, run: number }>,
  target: Coordinates,
  toleranceKm = 0.5,
): RouteSnapCandidate[] {
  if (samples.length < 3 || !validCoordinates(target.lat, target.lon)) return []
  const goal = { lat: target.lat, lon: target.lon, ele: null }
  const distances = new Array<number>(samples.length).fill(Infinity)
  let best = Infinity
  for (let i = 1; i < samples.length - 1; i++) {
    const d = distance(goal, { lat: samples[i].lat, lon: samples[i].lon, ele: null })
    distances[i] = d
    if (d < best) best = d
  }
  if (!Number.isFinite(best)) return []
  const threshold = best + toleranceKm
  const candidates: RouteSnapCandidate[] = []
  for (let i = 1; i < samples.length - 1; i++) {
    if (distances[i] > threshold) continue
    const run = samples[i].run
    let bestIdx = i
    let j = i + 1
    while (j < samples.length - 1 && samples[j].run === run && distances[j] <= threshold) {
      if (distances[j] < distances[bestIdx]) bestIdx = j
      j++
    }
    candidates.push({
      index: bestIdx,
      km: samples[bestIdx].km,
      distanceKm: distances[bestIdx],
    })
    i = j - 1
  }
  return candidates
}
