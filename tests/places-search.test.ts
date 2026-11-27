import { expect, test } from 'bun:test'
import {
  GOOGLE_PLACES_KEY_STORAGE,
  getGooglePlacesKey,
  resolvePlace,
  searchPlaces,
  setGooglePlacesKey,
  snapPlaceToRoute,
  trackBounds,
  type PlaceSuggestion,
} from '../src/places-search'

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    snapshot: () => Object.fromEntries(map),
  }
}

test('trackBounds computes padded bounds, handles empty tracks, and omits antimeridian wrap', () => {
  expect(trackBounds([])).toBeNull()
  expect(trackBounds([[]])).toBeNull()

  const local = trackBounds([[[
    { lat: 19.35, lon: 98.44, ele: 500 },
    { lat: 19.36, lon: 98.46, ele: 520 },
  ]]])
  expect(local).not.toBeNull()
  expect(local!.south).toBeCloseTo(19.1, 4)
  expect(local!.north).toBeCloseTo(19.61, 4)
  expect(local!.west).toBeCloseTo(98.19, 4)
  expect(local!.east).toBeCloseTo(98.71, 4)

  // Large track uses proportional 25% padding rather than tiny fixed margin
  const longTrip = trackBounds([[[
    { lat: 10, lon: 98, ele: null },
    { lat: 14, lon: 102, ele: null },
  ]]])
  expect(longTrip).toEqual({ south: 9, west: 97, north: 15, east: 103 })

  // Antimeridian crossing returns null instead of an inverted worldwide bbox
  const crossDateLine = trackBounds([[[
    { lat: -17, lon: 179.5, ele: null },
    { lat: -17, lon: -179.5, ele: null },
  ]]])
  expect(crossDateLine).toBeNull()
})

test('Google Places API key persists only in localStorage and degrades safely when storage throws', () => {
  const store = memoryStorage()
  expect(getGooglePlacesKey(store)).toBe('')
  expect(setGooglePlacesKey('  AIza-test-key  ', store)).toBe('AIza-test-key')
  expect(store.snapshot()).toEqual({ [GOOGLE_PLACES_KEY_STORAGE]: 'AIza-test-key' })
  expect(getGooglePlacesKey(store)).toBe('AIza-test-key')

  // Clearing removes the entry cleanly
  expect(setGooglePlacesKey('   ', store)).toBe('')
  expect(store.snapshot()).toEqual({})
  expect(getGooglePlacesKey(store)).toBe('')

  const broken = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  expect(getGooglePlacesKey(broken)).toBe('')
  expect(setGooglePlacesKey('abc', broken)).toBe('abc')
})

test('searchPlaces uses OSM Photon with GPX bbox bias when no Google key is configured', async () => {
  const calls: string[] = []
  const mockFetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          geometry: { type: 'Point', coordinates: [98.4405, 19.3582] },
          properties: { osm_id: 42, osm_type: 'N', name: 'Pai', city: 'Pai', state: 'Mae Hong Son', country: 'Thailand' },
        },
        {
          // Malformed coordinates must be skipped safely
          geometry: { type: 'Point', coordinates: [999, 19.3] },
          properties: { name: 'Bad coords' },
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  // Too-short queries make zero network calls
  const short = await searchPlaces('P', { fetchImpl: mockFetch })
  expect(short).toEqual({ provider: 'photon', suggestions: [] })
  expect(calls).toHaveLength(0)

  const bounds = { south: 18.5, west: 97.8, north: 19.8, east: 99.2 }
  const out = await searchPlaces('Pai', { bounds, limit: 5, fetchImpl: mockFetch })
  expect(out.provider).toBe('photon')
  expect(out.error).toBeUndefined()
  expect(out.suggestions).toHaveLength(1)
  expect(out.suggestions[0]).toMatchObject({
    name: 'Pai',
    subtitle: 'Mae Hong Son, Thailand',
    coords: { lat: 19.3582, lon: 98.4405 },
    provider: 'photon',
  })

  expect(calls).toHaveLength(1)
  const url = new URL(calls[0])
  expect(url.origin + url.pathname).toBe('https://photon.komoot.io/api/')
  expect(url.searchParams.get('q')).toBe('Pai')
  expect(url.searchParams.get('limit')).toBe('5')
  expect(url.searchParams.get('bbox')).toBe('97.8,18.5,99.2,19.8')
  expect(url.searchParams.get('lat')).toBe('19.15')
  expect(url.searchParams.get('lon')).toBe('98.5')

  // Resolving a Photon suggestion requires no second network call
  const resolved = await resolvePlace(out.suggestions[0], { fetchImpl: mockFetch })
  expect(calls).toHaveLength(1)
  expect(resolved.place).toEqual({
    name: 'Pai',
    subtitle: 'Mae Hong Son, Thailand',
    coords: { lat: 19.3582, lon: 98.4405 },
    provider: 'photon',
  })
})

test('Photon retries with center bias only when strict bbox yields zero features', async () => {
  const calls: URL[] = []
  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(url)
    const features = url.searchParams.has('bbox')
      ? []
      : [{
          geometry: { type: 'Point', coordinates: [98.9853, 18.7883] },
          properties: { osm_id: 99, osm_type: 'N', name: 'Chiang Mai', country: 'Thailand' },
        }]
    return new Response(JSON.stringify({ features }), { status: 200 })
  }) as typeof fetch

  const out = await searchPlaces('Chiang Mai', {
    bounds: { south: 19.2, west: 98.3, north: 19.5, east: 98.6 },
    fetchImpl: mockFetch,
  })
  expect(calls).toHaveLength(2)
  expect(calls[0].searchParams.has('bbox')).toBe(true)
  expect(calls[1].searchParams.has('bbox')).toBe(false)
  expect(calls[1].searchParams.get('lat')).toBe('19.35')
  expect(out.suggestions).toHaveLength(1)
  expect(out.suggestions[0].name).toBe('Chiang Mai')
})

test('searchPlaces and resolvePlace use Google Places API v1 when an API key is provided', async () => {
  const requests: { url: string, method: string, headers: Record<string, string>, body?: unknown }[] = []
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ url, method: init?.method || 'GET', headers, body })

    if (url.includes('places:autocomplete')) {
      return new Response(JSON.stringify({
        suggestions: [
          {
            placePrediction: {
              placeId: 'ChIJ_pai_123',
              text: { text: 'Pai, Mae Hong Son, Thailand' },
              structuredFormat: {
                mainText: { text: 'Pai' },
                secondaryText: { text: 'Mae Hong Son, Thailand' },
              },
            },
          },
        ],
      }), { status: 200 })
    }
    if (url.includes('/v1/places/ChIJ_pai_123')) {
      return new Response(JSON.stringify({
        displayName: { text: 'Pai' },
        formattedAddress: 'Pai District, Mae Hong Son, Thailand',
        location: { latitude: 19.3582, longitude: 98.4405 },
      }), { status: 200 })
    }
    return new Response('Not found', { status: 404 })
  }) as typeof fetch

  const bounds = { south: 18.5, west: 97.8, north: 19.8, east: 99.2 }
  const out = await searchPlaces('Pai', {
    apiKey: 'AIza-secret-key',
    bounds,
    sessionToken: 'sess-1',
    fetchImpl: mockFetch,
  })
  expect(out.provider).toBe('google')
  expect(out.suggestions).toHaveLength(1)
  expect(out.suggestions[0]).toMatchObject({
    name: 'Pai',
    subtitle: 'Mae Hong Son, Thailand',
    provider: 'google',
    placeId: 'ChIJ_pai_123',
  })
  expect(out.suggestions[0].coords).toBeUndefined()

  expect(requests[0].url).toBe('https://places.googleapis.com/v1/places:autocomplete')
  expect(requests[0].method).toBe('POST')
  expect(requests[0].headers['x-goog-api-key']).toBe('AIza-secret-key')
  expect(requests[0].headers['x-goog-fieldmask']).toContain('suggestions.placePrediction.placeId')
  expect(requests[0].body).toEqual({
    input: 'Pai',
    sessionToken: 'sess-1',
    locationBias: {
      rectangle: {
        low: { latitude: 18.5, longitude: 97.8 },
        high: { latitude: 19.8, longitude: 99.2 },
      },
    },
  })

  const resolved = await resolvePlace(out.suggestions[0], {
    apiKey: 'AIza-secret-key',
    sessionToken: 'sess-1',
    fetchImpl: mockFetch,
  })
  expect(resolved.error).toBeUndefined()
  expect(resolved.place).toEqual({
    name: 'Pai',
    subtitle: 'Mae Hong Son, Thailand',
    coords: { lat: 19.3582, lon: 98.4405 },
    provider: 'google',
  })
  expect(requests[1].url).toBe('https://places.googleapis.com/v1/places/ChIJ_pai_123?sessionToken=sess-1')
  expect(requests[1].headers['x-goog-api-key']).toBe('AIza-secret-key')
  expect(requests[1].headers['x-goog-fieldmask']).toContain('location')
})

test('searchPlaces and resolvePlace degrade gracefully offline, on HTTP errors, and on abort', async () => {
  const offlineFetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as unknown as typeof fetch

  const offlineOut = await searchPlaces('Pai', { fetchImpl: offlineFetch })
  expect(offlineOut.suggestions).toEqual([])
  expect(offlineOut.error).toMatch(/offline|coordinates/i)

  const forbiddenFetch = (async () => new Response('{}', { status: 403 })) as typeof fetch
  const forbiddenOut = await searchPlaces('Pai', { apiKey: 'bad-key', fetchImpl: forbiddenFetch })
  expect(forbiddenOut.suggestions).toEqual([])
  expect(forbiddenOut.error).toMatch(/Google Places key/i)

  const rateLimitedFetch = (async () => new Response('{}', { status: 429 })) as typeof fetch
  const rateOut = await searchPlaces('Pai', { apiKey: 'busy-key', fetchImpl: rateLimitedFetch })
  expect(rateOut.error).toMatch(/rate limit/i)

  const ac = new AbortController()
  ac.abort()
  const abortedOut = await searchPlaces('Pai', { signal: ac.signal, fetchImpl: offlineFetch })
  expect(abortedOut.aborted).toBe(true)
  expect(abortedOut.error).toBeUndefined()

  const googleSuggestion: PlaceSuggestion = {
    id: 'google:1',
    name: 'Pai',
    subtitle: 'Thailand',
    provider: 'google',
    placeId: 'place-1',
  }
  const failedResolve = await resolvePlace(googleSuggestion, { apiKey: 'AIza', fetchImpl: offlineFetch })
  expect(failedResolve.place).toBeUndefined()
  expect(failedResolve.error).toMatch(/offline|coordinates/i)
})

test('snapPlaceToRoute snaps to interior route points, collapses jitter, and separates distinct passes', () => {
  expect(snapPlaceToRoute([
    { lat: 18, lon: 98, km: 0, run: 0 },
    { lat: 18, lon: 98.01, km: 1, run: 0 },
  ], { lat: 18, lon: 98.01 })).toEqual([])

  // Out-and-back visits (18, 98.01) twice with a >2 km excursion in between
  const outAndBack = [
    { lat: 18, lon: 98.00, km: 0, run: 0 },
    { lat: 18, lon: 98.01, km: 1.1, run: 0 },
    { lat: 18.02, lon: 98.01, km: 3.3, run: 0 },
    { lat: 18, lon: 98.01, km: 5.5, run: 0 },
    { lat: 18, lon: 98.00, km: 6.6, run: 0 },
    { lat: 18, lon: 98.03, km: 9.8, run: 0 },
  ]
  const multi = snapPlaceToRoute(outAndBack, { lat: 18, lon: 98.01 })
  expect(multi.map(c => c.index)).toEqual([1, 3])
  expect(multi[0].distanceKm).toBeCloseTo(0, 4)
  expect(multi[1].distanceKm).toBeCloseTo(0, 4)

  // Noisy jitter within 0.1 km of target collapses into a single best pass
  const jittery = [
    { lat: 18.000, lon: 98.000, km: 0, run: 0 },
    { lat: 18.001, lon: 98.010, km: 1.0, run: 0 },
    { lat: 18.0002, lon: 98.010, km: 1.1, run: 0 },
    { lat: 18.0008, lon: 98.010, km: 1.2, run: 0 },
    { lat: 18.000, lon: 98.010, km: 1.3, run: 0 },
    { lat: 18.001, lon: 98.010, km: 1.4, run: 0 },
    { lat: 18.000, lon: 98.030, km: 3.5, run: 0 },
  ]
  const collapsed = snapPlaceToRoute(jittery, { lat: 18.000, lon: 98.010 })
  expect(collapsed).toHaveLength(1)
  expect(collapsed[0].index).toBe(4)

  // Never selects endpoint 0 or length - 1 even if closer than interior points
  const nearStart = [
    { lat: 18, lon: 98, km: 0, run: 0 },
    { lat: 18.01, lon: 98, km: 1.1, run: 0 },
    { lat: 18.02, lon: 98, km: 2.2, run: 0 },
    { lat: 18.03, lon: 98, km: 3.3, run: 0 },
  ]
  const interior = snapPlaceToRoute(nearStart, { lat: 18, lon: 98 })
  expect(interior).toHaveLength(1)
  expect(interior[0].index).toBe(1)
})
