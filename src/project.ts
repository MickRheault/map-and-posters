import { validCoordinates, type Assets } from './assets'
import type { Itinerary } from './itinerary'
import { defaultOutput, type OutputState } from './output'

export type SourceFile = { name: string, original: string }
export type Project = Assets & Itinerary & {
  output: OutputState
  sources: SourceFile[]
}

export function newProject(): Project {
  return {
    recordings: [], days: [], places: [], visits: [], photos: [],
    sources: [], output: defaultOutput()
  }
}

const format = 'map-and-posters'
const version = 1

export function backup(project: Project): string {
  return JSON.stringify({ format, version, project })
}

export function restore(text: string): Project {
  const data = JSON.parse(text)
  if (data?.format !== format || data.version !== version)
    throw new Error('Choose a Map & Posters version 1 backup.')
  validateProject(data.project)
  return data.project
}

function demand(condition: unknown): asserts condition {
  if (!condition) throw new Error('This backup contains invalid project data.')
}

const isText = (value: unknown) => typeof value === 'string'
const isId = (id: unknown) => typeof id === 'string' && id.length > 0 &&
  !['__proto__', 'constructor', 'prototype'].includes(id)
const isColor = (value: unknown) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
const isFile = (value: unknown) => typeof value === 'string' && /^data:[^,]*;base64,/.test(value)
const isRecord = (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value))

function validateProject(value: unknown): asserts value is Project {
  demand(isRecord(value))
  const project = value as Project
  for (const list of [project.recordings, project.days, project.places, project.visits, project.photos]) {
    demand(Array.isArray(list))
    demand(list.every(item => item && isId(item.id)))
    demand(new Set(list.map(item => item.id)).size === list.length)
  }
  demand(Array.isArray(project.sources))
  demand(project.sources.every(source => source && isText(source.name) && isFile(source.original)))

  const recordings = new Map(project.recordings.map(recording => [recording.id, recording]))
  for (const recording of recordings.values()) {
    demand(isText(recording.name) && isText(recording.xml) && typeof recording.included === 'boolean')
    demand(Array.isArray(recording.track) && recording.track.length)
    for (const line of recording.track) {
      demand(Array.isArray(line) && line.length)
      demand(line.every(p => p && validCoordinates(p.lat, p.lon) && (p.ele === null || Number.isFinite(p.ele))
        && (p.time === undefined || isText(p.time))))
    }
  }
  const dayIds = new Set(project.days.map(day => day.id))
  for (const day of project.days) {
    demand(isText(day.name) && isColor(day.color) && typeof day.rest === 'boolean' && Array.isArray(day.ranges))
    demand(day.rest ? day.ranges.length === 0 : day.ranges.length > 0)
    for (const range of day.ranges) {
      demand(range && [range.segment, range.start, range.end].every(Number.isInteger))
      const line = recordings.get(range.recordingId)?.track[range.segment]
      demand(line && range.start >= 0 && range.end >= range.start && range.end < line.length)
    }
  }
  const placeIds = new Set(project.places.map(place => place.id))
  for (const place of project.places) {
    demand(validCoordinates(place.lat, place.lon) && isText(place.name) && isText(place.category)
      && typeof place.visible === 'boolean')
  }
  for (const visit of project.visits) {
    demand(dayIds.has(visit.dayId) && placeIds.has(visit.placeId) && typeof visit.overnight === 'boolean')
    if (visit.position !== undefined) {
      const ref = visit.position
      demand(ref && Number.isInteger(ref.segment) && Number.isInteger(ref.point))
      demand(recordings.get(ref.recordingId)?.track[ref.segment]?.[ref.point])
    }
  }
  for (const photo of project.photos) {
    demand(isText(photo.name) && (photo.dayId === '' || dayIds.has(photo.dayId)) && typeof photo.hero === 'boolean')
    demand(typeof photo.src === 'string' && /^data:image\/(?:jpeg|png);base64,/i.test(photo.src) && isFile(photo.original))
    demand([photo.cropX, photo.cropY, photo.zoom, photo.width, photo.height].every(Number.isFinite))
    demand(photo.cropX >= 0 && photo.cropX <= 1 && photo.cropY >= 0 && photo.cropY <= 1
      && photo.zoom >= 1 && photo.width > 0 && photo.height > 0)
    if (photo.gps !== undefined) demand(photo.gps && validCoordinates(photo.gps.lat, photo.gps.lon))
    if (photo.placeId !== undefined) demand(placeIds.has(photo.placeId))
  }
  const out = project.output
  demand(out && isText(out.title) && isText(out.credit) && isColor(out.accent))
  demand(isText(out.active) && ['jpg', 'png'].includes(out.format))
  demand([out.showDistance, out.showPeak, out.showProfile, out.phone].every(v => typeof v === 'boolean'))
  demand(Array.isArray(out.groups) && Array.isArray(out.selected) && out.selected.every(isText))
  for (const group of out.groups) {
    demand(group && isId(group.id) && isText(group.name) && Array.isArray(group.dayIds))
    demand(group.dayIds.every(id => dayIds.has(id)))
  }
  if (out.placeText !== undefined) {
    demand(isRecord(out.placeText))
    for (const modes of Object.values(out.placeText))
      demand(isRecord(modes) && Object.values(modes).every(v => ['name', 'category', 'both', 'pin'].includes(v)))
  }
  demand(isRecord(out.placeVisibility))
  for (const flags of Object.values(out.placeVisibility))
    demand(isRecord(flags) && Object.values(flags).every(v => typeof v === 'boolean'))
  demand(isRecord(out.labels))
  for (const labels of Object.values(out.labels)) {
    demand(isRecord(labels))
    for (const position of Object.values(labels)) demand(position && Number.isFinite(position.x) && Number.isFinite(position.y))
  }
}
