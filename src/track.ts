export type Point = { lat: number, lon: number, ele: number | null }
export type Track = Point[][]
const rad = Math.PI / 180

export function distance(a: Point, b: Point) {
  const h = Math.sin((b.lat-a.lat)*rad/2)**2 +
    Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((b.lon-a.lon)*rad/2)**2
  return 12742 * Math.asin(Math.sqrt(Math.min(1,h)))
}

export function parseTrack(xml: string): Track {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.documentElement.localName !== 'gpx' || doc.getElementsByTagName('parsererror').length)
    throw new Error('Choose a valid GPX file.')
  function* children(el: Element, name: string): Generator<Element> {
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
      if (child.localName === name) yield child
    }
  }
  const track: Track = []
  for (const trk of children(doc.documentElement,'trk')) {
    for (const seg of children(trk,'trkseg')) {
      let run: Point[] = []
      for (const el of children(seg,'trkpt')) {
        const number = (value?: string | null) => value?.trim() ? Number(value) : NaN
        const lat = number(el.getAttribute('lat')), lon = number(el.getAttribute('lon'))
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180) {
          if (run.length) track.push(run)
          run = []
          continue
        }
        const elevation = number(children(el,'ele').next().value?.textContent)
        run.push({lat, lon, ele: Number.isFinite(elevation) ? elevation : null})
      }
      if (run.length) track.push(run)
    }
  }
  if (!track.length) throw new Error('This file contains no recorded track points.')
  return track
}

export function layout(track: Track) {
  let km = 0, peak = -Infinity, low = Infinity
  let west = Infinity, east = -Infinity, north = -Infinity, south = Infinity
  const anchor = track[0][0].lon
  const lines = track.map(segment => segment.map((p,i) => {
    if (i) km += distance(segment[i-1],p)
    const x = ((p.lon-anchor+540)%360)-180
    const y = Math.log(Math.tan(Math.PI/4 + Math.max(-85.0511,Math.min(85.0511,p.lat))*rad/2))/rad
    west=Math.min(west,x); east=Math.max(east,x); south=Math.min(south,y); north=Math.max(north,y)
    if (p.ele !== null) { peak=Math.max(peak,p.ele); low=Math.min(low,p.ele) }
    return {x,y,km,ele:p.ele}
  }))
  return {lines,km,peak,low,west,east,north,south}
}
