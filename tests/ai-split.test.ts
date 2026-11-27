import { expect, test } from 'bun:test'
import { addPlace } from '../src/assets'
import { importRecording } from '../src/itinerary'
import { backup, newProject, restore, type Project } from '../src/project'
import {
  AI_STORAGE_KEYS,
  applyAiSplitPlan,
  buildAiSplitPlan,
  clearAiConfig,
  collectRouteSamples,
  findTrackPasses,
  geocodePlace,
  loadAiConfig,
  parseNaturalItinerary,
  saveAiConfig,
  selectPlanPass,
  validateEndpointUrl,
  type AiConfig,
} from '../src/ai-split'

function makeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    map,
  }
}

function gpxXml(coords: [number, number][]) {
  const pts = coords.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('')
  return `<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`
}

function projectWithCoords(coords: [number, number][], name = 'route.gpx'): Project {
  const project = newProject()
  importRecording(project, gpxXml(coords), name)
  return project
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('localStorage config loads defaults, saves/clears keys locally, and validates endpoint URLs', () => {
  const store = makeStorage()
  const initial = loadAiConfig(store)
  expect(initial.provider).toBe('openai')
  expect(initial.apiKey).toBe('')
  expect(initial.googlePlacesKey).toBe('')

  const saved = saveAiConfig({
    provider: 'gemini',
    apiKey: 'secret-gemini-key',
    model: 'gemini-2.5-flash',
    endpoint: 'https://proxy.example.com/v1beta/models/gemini:generateContent',
    googlePlacesKey: 'secret-places-key',
  }, store)
  expect(saved.provider).toBe('gemini')
  expect(store.map.get(AI_STORAGE_KEYS.apiKey)).toBe('secret-gemini-key')
  expect(store.map.get(AI_STORAGE_KEYS.googlePlacesKey)).toBe('secret-places-key')
  expect(AI_STORAGE_KEYS.googlePlacesKey).toBe('map-and-posters:google-places-key')

  const reloaded = loadAiConfig(store)
  expect(reloaded).toEqual(saved)

  expect(validateEndpointUrl('')).toBe('')
  expect(validateEndpointUrl('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions')
  expect(validateEndpointUrl('http://localhost:11434/v1/chat/completions')).toBe('http://localhost:11434/v1/chat/completions')
  expect(validateEndpointUrl('http://127.0.0.1:1234/v1/chat/completions')).toBe('http://127.0.0.1:1234/v1/chat/completions')
  expect(() => validateEndpointUrl('http://insecure.example.com/v1')).toThrow()
  expect(() => validateEndpointUrl('javascript:alert(1)')).toThrow()

  clearAiConfig(store)
  expect(loadAiConfig(store).apiKey).toBe('')
  expect(loadAiConfig(store).googlePlacesKey).toBe('')
})

test('parseNaturalItinerary formats OpenAI-compatible and Gemini requests and ignores LLM-supplied coordinates', async () => {
  const project = projectWithCoords([[18.79, 98.98], [19.1, 98.7], [19.36, 98.44], [19.3, 97.96]])
  const calls: { url: string, init?: RequestInit }[] = []
  const openAiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            days: [
              // Deliberately include hallucinated lat/lon to verify they are discarded
              { dayNumber: 1, kind: 'ride', endPlace: 'Pai', overnightPlace: 'Pai', lat: 0, lon: 0 },
              { dayNumber: 2, kind: 'rest', name: 'Pai', overnightPlace: 'Pai', coordinates: [1, 2] },
            ],
          }),
        },
      }],
    })
  }) as typeof fetch

  const openaiConfig: AiConfig = {
    provider: 'openai',
    apiKey: 'sk-test-123',
    model: 'gpt-4o-mini',
    endpoint: '',
    googlePlacesKey: '',
  }
  const parsed = await parseNaturalItinerary('Day 1 finished in Pai, Day 2 was a rest day in Pai', project, openaiConfig, { fetchImpl: openAiFetch })
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
  const headers = calls[0].init?.headers as Record<string, string>
  expect(headers.Authorization).toBe('Bearer sk-test-123')
  expect(parsed).toEqual([
    { dayNumber: 1, kind: 'ride', endPlace: 'Pai', overnightPlace: 'Pai' },
    { dayNumber: 2, kind: 'rest', name: 'Pai', overnightPlace: 'Pai' },
  ])
  expect('lat' in parsed[0]).toBe(false)
  expect('lon' in parsed[0]).toBe(false)

  // Verify Gemini API format (uses x-goog-api-key header, never leaks key in URL)
  const geminiCalls: { url: string, init?: RequestInit }[] = []
  const geminiFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    geminiCalls.push({ url: String(input), init })
    return jsonResponse({
      candidates: [{
        content: {
          parts: [{
            text: '```json\n{"days":[{"kind":"ride","endPlace":"Pai"},{"kind":"rest","name":"Rest in Pai"}]}\n```',
          }],
        },
      }],
    })
  }) as typeof fetch

  const geminiConfig: AiConfig = {
    provider: 'gemini',
    apiKey: 'gem-secret-key',
    model: 'gemini-2.5-flash',
    endpoint: '',
    googlePlacesKey: '',
  }
  const gemParsed = await parseNaturalItinerary('Day 1 to Pai, Day 2 rest', project, geminiConfig, { fetchImpl: geminiFetch })
  expect(geminiCalls[0].url).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
  expect(geminiCalls[0].url).not.toContain('gem-secret-key')
  expect((geminiCalls[0].init?.headers as Record<string, string>)['x-goog-api-key']).toBe('gem-secret-key')
  expect(gemParsed).toHaveLength(2)
  expect(gemParsed[0].endPlace).toBe('Pai')
  expect(gemParsed[1].kind).toBe('rest')
})

test('geocodePlace uses GPX-bounded Photon by default, Google Places when keyed, existing waypoints first, and rejects missing results', async () => {
  const project = projectWithCoords([[18.79, 98.98], [19.36, 98.44], [19.3, 97.96]])
  const { samples, bounds } = collectRouteSamples(project)
  expect(bounds).not.toBeNull()

  // 1. OSM Photon bounded by bbox
  const photonUrls: string[] = []
  const photonFetch = (async (input: RequestInfo | URL) => {
    photonUrls.push(String(input))
    return jsonResponse({
      features: [
        { geometry: { coordinates: [98.4405, 19.3595] }, properties: { name: 'Pai', state: 'Mae Hong Son' } },
      ],
    })
  }) as typeof fetch

  const pai = await geocodePlace('Pai', project, bounds!, samples, { fetchImpl: photonFetch })
  expect(pai).toMatchObject({ name: 'Pai', source: 'photon' })
  expect(pai!.lat).toBeCloseTo(19.3595, 4)
  expect(pai!.lon).toBeCloseTo(98.4405, 4)
  expect(photonUrls[0]).toContain('photon.komoot.io/api/')
  expect(photonUrls[0]).toContain('bbox=')

  // 2. Google Places when googlePlacesKey is provided
  const googleCalls: { url: string, body: string, headers: Record<string, string> }[] = []
  const googleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    googleCalls.push({
      url: String(input),
      body: String(init?.body || ''),
      headers: (init?.headers || {}) as Record<string, string>,
    })
    return jsonResponse({
      places: [
        { displayName: { text: 'Pai' }, location: { latitude: 19.36, longitude: 98.44 } },
      ],
    })
  }) as typeof fetch

  const viaGoogle = await geocodePlace('Pai', project, bounds!, samples, {
    googlePlacesKey: 'gplaces-key',
    fetchImpl: googleFetch,
  })
  expect(viaGoogle).toMatchObject({ name: 'Pai', source: 'google', lat: 19.36, lon: 98.44 })
  expect(googleCalls[0].url).toBe('https://places.googleapis.com/v1/places:searchText')
  expect(googleCalls[0].headers['X-Goog-Api-Key']).toBe('gplaces-key')
  expect(googleCalls[0].body).toContain('locationBias')

  // 3. Existing project waypoint matches directly without hitting the network
  addPlace(project, 'Pai', { lat: 19.361, lon: 98.441 })
  let called = false
  const noNetFetch = (async () => { called = true; throw new Error('should not fetch') }) as unknown as typeof fetch
  const viaWaypoint = await geocodePlace('pai', project, bounds!, samples, { fetchImpl: noNetFetch })
  expect(called).toBe(false)
  expect(viaWaypoint).toMatchObject({ name: 'Pai', source: 'project', lat: 19.361, lon: 98.441 })

  // 4. Empty Photon response returns null instead of inventing coordinates
  const emptyFetch = (async () => jsonResponse({ features: [] })) as typeof fetch
  const missing = await geocodePlace('Atlantis', project, bounds!, samples, { fetchImpl: emptyFetch })
  expect(missing).toBeNull()
})

test('findTrackPasses clusters GPS jitter into 1 pass while preserving genuine repeated passes on out-and-backs', () => {
  // Jittery pass through Pai (~19.36, 98.44) — small ~0.1-0.2 km wobbles should collapse into 1 pass
  const jitterProject = projectWithCoords([
    [19.10, 98.44],
    [19.358, 98.44],
    [19.361, 98.441],
    [19.359, 98.44],
    [19.360, 98.44],
    [19.362, 98.441],
    [19.60, 98.44],
  ])
  const jitterSamples = collectRouteSamples(jitterProject).samples
  const jitterPasses = findTrackPasses(jitterSamples, { lat: 19.36, lon: 98.44 })
  expect(jitterPasses).toHaveLength(1)
  expect(jitterPasses[0].sampleIndex).toBe(4)

  // Genuine out-and-back visiting (18, 98.01) twice with a >2 km excursion in between
  const outAndBack = projectWithCoords([
    [18.00, 98.00],
    [18.00, 98.01], // Pass 1
    [18.03, 98.01], // ~3.3 km away
    [18.00, 98.01], // Pass 2
    [18.00, 98.05],
  ])
  const oabSamples = collectRouteSamples(outAndBack).samples
  const oabPasses = findTrackPasses(oabSamples, { lat: 18.0, lon: 98.01 })
  expect(oabPasses).toHaveLength(2)
  expect(oabPasses.map(p => p.sampleIndex)).toEqual([1, 3])
})

test('buildAiSplitPlan produces a reviewable plan without mutating project, supports pass switching, and applyAiSplitPlan preserves backup schema v1 without leaking keys', async () => {
  // Out-and-back route that passes through Pai twice before continuing to Mae Hong Son
  const project = projectWithCoords([
    [18.80, 98.98], // 0: Chiang Mai start
    [19.36, 98.44], // 1: Pai (Pass 1)
    [19.50, 98.44], // 2: North loop excursion (~15 km)
    [19.36, 98.44], // 3: Pai (Pass 2)
    [19.30, 97.96], // 4: Mae Hong Son finish
  ], 'mhs-loop.gpx')
  const snapshotBefore = backup(project)

  const config: AiConfig = {
    provider: 'openai',
    apiKey: 'sk-super-secret-do-not-backup',
    model: 'gpt-4o-mini',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    googlePlacesKey: 'gplaces-secret-do-not-backup',
  }

  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('chat/completions')) {
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              days: [
                { dayNumber: 1, kind: 'ride', endPlace: 'Pai', overnightPlace: 'Pai' },
                { dayNumber: 2, kind: 'rest', name: 'Pai', overnightPlace: 'Pai' },
              ],
            }),
          },
        }],
      })
    }
    if (url.includes('places:searchText')) {
      return jsonResponse({
        places: [{ displayName: { text: 'Pai' }, location: { latitude: 19.36, longitude: 98.44 } }],
      })
    }
    throw new Error('Unexpected URL: ' + url)
  }) as typeof fetch

  const plan = await buildAiSplitPlan('Day 1 finished in Pai, Day 2 was a rest day in Pai', project, config, { fetchImpl: mockFetch })

  // Project MUST NOT be mutated before explicit apply!
  expect(backup(project)).toBe(snapshotBefore)

  // Plan proposes Day 1 (ride to Pai), Day 2 (rest in Pai), and inferred Day 3 (remaining route)
  expect(plan.canApply).toBe(true)
  expect(plan.days).toHaveLength(3)
  expect(plan.days.map(d => d.kind)).toEqual(['ride', 'rest', 'ride'])
  expect(plan.days[0].split?.ambiguous).toBe(true)
  expect(plan.days[0].split?.candidates).toHaveLength(2)
  expect(plan.days[0].split?.selectedPassIndex).toBe(0)
  expect(plan.days[1].name).toBe('Pai')
  expect(plan.days[2].inferredRemainder).toBe(true)

  const day1KmPass1 = plan.days[0].km
  const day3KmPass1 = plan.days[2].km

  // User confirms Pass 2 on the review plan
  const updatedPlan = selectPlanPass(plan, plan.days[0].id, 1)
  expect(updatedPlan.days[0].split?.selectedPassIndex).toBe(1)
  expect(updatedPlan.days[0].km).toBeGreaterThan(day1KmPass1)
  expect(updatedPlan.days[2].km).toBeLessThan(day3KmPass1)
  expect(updatedPlan.days[0].km + updatedPlan.days[2].km).toBeCloseTo(plan.totalKm, 3)

  // Still not mutated until applyAiSplitPlan is called
  expect(backup(project)).toBe(snapshotBefore)

  applyAiSplitPlan(project, updatedPlan)

  expect(project.days).toHaveLength(3)
  expect(project.days.map(d => d.rest)).toEqual([false, true, false])
  expect(project.days[0].ranges[0].end).toBe(3) // Pass 2!
  expect(project.days[1].name).toBe('Pai')
  expect(project.days[2].ranges[0].start).toBe(3)
  expect(project.days[2].ranges[0].end).toBe(4)

  // Verified overnight place & visits added cleanly
  const paiPlace = project.places.find(p => p.name === 'Pai')
  expect(paiPlace).toBeDefined()
  expect(paiPlace!.visible).toBe(true)
  const overnights = project.visits.filter(v => v.placeId === paiPlace!.id && v.overnight)
  expect(overnights).toHaveLength(2)
  expect(overnights[0].dayId).toBe(project.days[0].id)
  expect(overnights[0].position).toMatchObject({ point: 3 })
  expect(overnights[1].dayId).toBe(project.days[1].id)
  expect(overnights[1].position).toBeUndefined()

  // Backup v1 validation passes AND contains zero API keys or endpoints!
  const serialized = backup(project)
  expect(serialized).not.toContain('sk-super-secret-do-not-backup')
  expect(serialized).not.toContain('gplaces-secret-do-not-backup')
  expect(serialized).not.toContain('chat/completions')
  const restored = restore(serialized)
  expect(restored.days).toHaveLength(3)
  expect(restored.visits).toHaveLength(2)
})

test('buildAiSplitPlan flags unresolved places and out-of-order passes instead of silently applying bogus splits', async () => {
  const project = projectWithCoords([
    [18.80, 98.98],
    [19.00, 98.80],
    [19.20, 98.60],
    [19.36, 98.44],
    [19.30, 97.96],
  ])
  const config: AiConfig = {
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    endpoint: '',
    googlePlacesKey: '',
  }

  // Case 1: Unresolved place (far from GPX / empty geocode)
  const unresolvedFetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('chat/completions')) {
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ days: [{ kind: 'ride', endPlace: 'Atlantis' }] }) } }],
      })
    }
    return jsonResponse({ features: [] })
  }) as typeof fetch

  const unresolvedPlan = await buildAiSplitPlan('Day 1 finished in Atlantis', project, config, { fetchImpl: unresolvedFetch })
  expect(unresolvedPlan.canApply).toBe(false)
  expect(unresolvedPlan.errors.some(e => e.includes('Atlantis'))).toBe(true)
  expect(() => applyAiSplitPlan(project, unresolvedPlan)).toThrow()

  // Case 2: Out-of-order passes (Day 1 after Day 2)
  const outOfOrderFetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('chat/completions')) {
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              days: [
                { kind: 'ride', endPlace: 'LateTown' },
                { kind: 'ride', endPlace: 'EarlyTown' },
              ],
            }),
          },
        }],
      })
    }
    if (url.includes('LateTown')) {
      return jsonResponse({ features: [{ geometry: { coordinates: [98.44, 19.36] }, properties: { name: 'LateTown' } }] })
    }
    return jsonResponse({ features: [{ geometry: { coordinates: [98.80, 19.00] }, properties: { name: 'EarlyTown' } }] })
  }) as typeof fetch

  const badOrderPlan = await buildAiSplitPlan('Day 1 LateTown, Day 2 EarlyTown', project, config, { fetchImpl: outOfOrderFetch })
  expect(badOrderPlan.canApply).toBe(false)
  expect(badOrderPlan.errors.some(e => /order|earlier/i.test(e))).toBe(true)
})

test('buildAiSplitPlan degrades cleanly on network failure without mutating project', async () => {
  const project = projectWithCoords([[18.80, 98.98], [19.36, 98.44], [19.30, 97.96]])
  const config: AiConfig = {
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    endpoint: '',
    googlePlacesKey: '',
  }
  const offlineFetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as unknown as typeof fetch

  await expect(buildAiSplitPlan('Day 1 in Pai', project, config, { fetchImpl: offlineFetch }))
    .rejects.toThrow(/offline|network|reach/i)
  expect(project.days).toHaveLength(1)
})

test('geocodePlace falls back to OSM Photon when Google Places fails, and final day ending at route finish creates no spurious remainder day', async () => {
  const project = projectWithCoords([
    [18.80, 98.98], // Chiang Mai
    [19.36, 98.44], // Pai
    [19.30, 97.96], // Mae Hong Son (route finish)
  ])
  const config: AiConfig = {
    provider: 'gemini',
    apiKey: 'gem-key',
    model: 'gemini-2.5-flash',
    endpoint: '',
    googlePlacesKey: 'broken-google-key',
  }

  let googleTried = false
  let photonFallbackUsed = false
  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonResponse({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                days: [
                  { dayNumber: 1, kind: 'ride', endPlace: 'Pai', overnightPlace: 'Pai' },
                  { dayNumber: 2, kind: 'ride', endPlace: 'Mae Hong Son', overnightPlace: 'Mae Hong Son' },
                ],
              }),
            }],
          },
        }],
      })
    }
    if (url.includes('places:searchText')) {
      googleTried = true
      return new Response('Forbidden', { status: 403 })
    }
    if (url.includes('photon.komoot.io')) {
      photonFallbackUsed = true
      if (url.includes('Pai')) {
        return jsonResponse({ features: [{ geometry: { coordinates: [98.44, 19.36] }, properties: { name: 'Pai' } }] })
      }
      return jsonResponse({ features: [{ geometry: { coordinates: [97.96, 19.30] }, properties: { name: 'Mae Hong Son' } }] })
    }
    throw new Error('Unexpected URL: ' + url)
  }) as typeof fetch

  const plan = await buildAiSplitPlan('Day 1 finished in Pai, Day 2 finished in Mae Hong Son', project, config, { fetchImpl: mockFetch })
  expect(googleTried).toBe(true)
  expect(photonFallbackUsed).toBe(true)
  expect(plan.canApply).toBe(true)
  expect(plan.days).toHaveLength(2)
  expect(plan.days[1].split?.isRouteEnd).toBe(true)

  applyAiSplitPlan(project, plan)
  expect(project.days).toHaveLength(2)
  expect(project.places.map(p => p.name)).toEqual(['Pai', 'Mae Hong Son'])
  expect(restore(backup(project)).days).toHaveLength(2)
})
