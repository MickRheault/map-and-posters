import { parseGpx, type Track } from './track'

export interface Coordinates { lat: number, lon: number }
export interface Place extends Coordinates {
  id: string
  name: string
  category: string
  visible: boolean
}
export interface Visit {
  id: string
  placeId: string
  dayId: string
  overnight: boolean
  position?: { recordingId: string, segment: number, point: number }
}
export interface Photo {
  id: string
  name: string
  src: string
  original: string
  dayId: string
  hero: boolean
  cropX: number
  cropY: number
  zoom: number
  width: number
  height: number
  gps?: Coordinates
  placeId?: string
}
export interface Assets { places: Place[], visits: Visit[], photos: Photo[] }

export function validCoordinates(lat: number, lon: number) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}

const decimal = '([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))'
const pair = new RegExp('^\\s*' + decimal + '\\s*,\\s*' + decimal + '\\s*$')

export function readCoordinates(value: string): Coordinates | null {
  function match(value: string, pattern: RegExp) {
    const m = pattern.exec(value)
    if (!m) return null
    const lat = Number(m[1]), lon = Number(m[2])
    return validCoordinates(lat, lon) ? {lat, lon} : null
  }
  const direct = match(value, pair)
  if (direct) return direct
  let url: URL
  try { url = new URL(value.trim()) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol)) return null
  // A Google place URL can contain multiple pins and an unrelated camera center.
  const pins = Array.from(url.pathname.matchAll(new RegExp('!3d' + decimal + '!4d' + decimal, 'g')))
  if (pins.length) return match(pins[pins.length-1].slice(1, 3).join(','), pair)
  for (const param of ['query', 'q', 'destination', 'll']) {
    const hit = match(url.searchParams.get(param) || '', pair)
    if (hit) return hit
  }
  const mlat = url.searchParams.get('mlat'), mlon = url.searchParams.get('mlon')
  if (mlat !== null && mlon !== null) return match([mlat, mlon].join(','), pair)
  if (/\/maps\/(?:place|search|dir)\//i.test(url.pathname)) return null
  return match(url.hash, new RegExp('^#map=\\d+(?:\\.\\d+)?/' + decimal + '/' + decimal + '$')) ||
    match(url.pathname, new RegExp('/@' + decimal + ',' + decimal + '(?:[,/]|$)'))
}

export function addPlace(assets: Pick<Assets,'places'>, name: string, coords: Coordinates, visible = true, category = 'Place'): Place {
  if (!validCoordinates(coords.lat, coords.lon)) throw new Error('Enter a valid latitude and longitude.')
  const place = {id: crypto.randomUUID(), name: name.trim() || 'Unnamed place', lat: coords.lat, lon: coords.lon, category, visible}
  assets.places.push(place)
  return place
}

export function importWaypoints(assets: Pick<Assets,'places'>, input: string | Document): number {
  const root = (typeof input === 'string' ? parseGpx(input) : input).documentElement
  let count = 0
  for (let el = root.firstElementChild; el; el = el.nextElementSibling) {
    if (el.localName !== 'wpt') continue
    const lat = el.getAttribute('lat')?.trim(), lon = el.getAttribute('lon')?.trim()
    if (!lat || !lon || !validCoordinates(Number(lat), Number(lon))) continue
    const childText = (name: string) => Array.from(el!.children).find(node => node.localName === name)?.textContent?.trim()
    addPlace(assets, childText('name') || 'Waypoint', {lat: Number(lat), lon: Number(lon)}, false, childText('type') || 'Place')
    count++
  }
  return count
}

function xmlText(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function exportGpx(places: Place[], recordings: {included: boolean, track: Track, name: string}[]): string {
  const pins = places.filter(place => place.visible).map(place =>
    `<wpt lat="${place.lat}" lon="${place.lon}"><name>${xmlText(place.name)}</name><type>${xmlText(place.category)}</type></wpt>`)
  const tracks = recordings.filter(r => r.included).map(r => {
    const segments = r.track.map(points => '<trkseg>' + points.map(point =>
      `<trkpt lat="${point.lat}" lon="${point.lon}">${point.ele === null ? '' : '<ele>' + point.ele + '</ele>'}${point.time ? '<time>' + xmlText(point.time) + '</time>' : ''}</trkpt>`).join('') + '</trkseg>')
    return '<trk><name>' + xmlText(r.name) + '</name>' + segments.join('') + '</trk>'
  })
  return '<?xml version="1.0" encoding="UTF-8"?><gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Map &amp; Posters">' + pins.join('') + tracks.join('') + '</gpx>'
}

// GPS coordinates use a TIFF IFD inside JPEG APP1 or PNG eXIf metadata.
function tiffGps(bytes: Uint8Array): Coordinates | undefined {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const order = data.getUint16(0)
  if (order !== 0x4949 && order !== 0x4d4d) return
  const le = order === 0x4949
  const u16 = (offset: number) => data.getUint16(offset, le)
  const u32 = (offset: number) => data.getUint32(offset, le)
  if (u16(2) !== 42) return
  function entry(table: number, tag: number) {
    const count = u16(table)
    if (table + 2 + count * 12 > bytes.length) return
    for (let i = 0; i < count; i++) {
      const offset = table + 2 + i * 12
      if (u16(offset) === tag) return offset
    }
  }
  const gpsEntry = entry(u32(4), 0x8825)
  if (gpsEntry === undefined || u16(gpsEntry + 2) !== 4 || u32(gpsEntry + 4) !== 1) return
  const gps = u32(gpsEntry + 8)
  function coord(refTag: number, positive: string, negative: string) {
    const ref = entry(gps, refTag), val = entry(gps, refTag + 1)
    if (ref === undefined || val === undefined || u16(ref+2) !== 2 || u32(ref+4) !== 2 || u16(val+2) !== 5 || u32(val+4) !== 3) return NaN
    const sign = String.fromCharCode(data.getUint8(ref + 8))
    if (sign !== positive && sign !== negative) return NaN
    const start = u32(val + 8)
    const rational = (i: number) => u32(start + i*8) / u32(start + i*8 + 4)
    const degrees = rational(0) + rational(1)/60 + rational(2)/3600
    return sign === negative ? -degrees : degrees
  }
  const lat = coord(1, 'N', 'S'), lon = coord(3, 'E', 'W')
  if (validCoordinates(lat, lon)) return {lat, lon}
}

export function photoGps(buffer: ArrayBuffer): Coordinates | undefined {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer)
  try {
    if (view.getUint16(0) === 0xffd8) {
      for (let i = 2; i + 4 <= bytes.length && bytes[i] === 0xff;) {
        const marker = bytes[i+1], size = view.getUint16(i+2)
        if (marker === 0xda || size < 2 || i+2+size > bytes.length) break
        if (marker === 0xe1 && size >= 8 && view.getUint32(i+4) === 0x45786966 && view.getUint16(i+8) === 0) {
          const gps = tiffGps(bytes.subarray(i+10, i+2+size))
          if (gps) return gps
        }
        i += 2 + size
      }
    }
    if (view.getUint32(0) === 0x89504e47) {
      for (let i = 8; i+12 <= bytes.length;) {
        const size = view.getUint32(i)
        if (i + size + 12 > bytes.length) break
        if (view.getUint32(i+4) === 0x65584966) return tiffGps(bytes.subarray(i+8, i+8+size))
        i += size+12
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
}

export function asDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve,reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read the selected file.'))
    reader.readAsDataURL(file)
  })
}

export async function readPhoto(file: File, dayId: string): Promise<Photo> {
  const bytes = await file.arrayBuffer()
  const header = new DataView(bytes)
  if (bytes.byteLength < 8 || (header.getUint16(0) !== 0xffd8 && header.getUint32(0) !== 0x89504e47)) {
    throw new Error('Choose a JPEG or PNG photo.')
  }
  const type = header.getUint16(0) === 0xffd8 ? 'image/jpeg' : 'image/png'
  const image = new Image()
  const source = URL.createObjectURL(new Blob([bytes], {type}))
  try {
    image.src = source
    await image.decode()
    const scale = Math.min(1, 2048/Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not prepare this photo.')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0,0,canvas.width,canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return {
      id: crypto.randomUUID(), name: file.name, original: await asDataUrl(new Blob([bytes], {type})),
      src: canvas.toDataURL('image/jpeg', 0.92), dayId, hero: false,
      width: canvas.width, height: canvas.height, cropX: 0.5, cropY: 0.5, zoom: 1, gps: photoGps(bytes)
    }
  } finally { URL.revokeObjectURL(source) }
}
