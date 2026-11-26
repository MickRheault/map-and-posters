import { expect, test } from 'bun:test'
import { backup, newProject, restore } from '../src/project'
import { importRecording, insertRestDay } from '../src/itinerary'
import { addPlace } from '../src/assets'

function example() {
  const p = newProject()
  const xml='<gpx><trk><trkseg><trkpt lat="18" lon="98"><ele>41</ele></trkpt></trkseg></trk></gpx>'
  const source=importRecording(p,xml,'First.gpx')
  p.sources.push({name:source.name,original:'data:application/gpx+xml;base64,'+btoa(xml)})
  const rest=insertRestDay(p,1,'Pai')
  const place=addPlace(p,'Farm stay',{lat:18,lon:98})
  p.visits.push({id:'stay',placeId:place.id,dayId:rest.id,overnight:true})
  return p
}
test('versioned backup round-trips original files, waypoint visits and rest-day order',()=>{
  const p=example()
  const result=restore(backup(p))
  expect(result).toEqual(p)
  expect(atob(result.sources[0].original.split(',')[1])).toBe(p.recordings[0].xml)
})
test('invalid versions, damaged recording ranges and dangling visits are rejected',()=>{
  const p=example()
  expect(()=>restore(JSON.stringify({format:'map-and-posters',version:10,project:p}))).toThrow()
  p.days[0].ranges[0].end=100
  expect(()=>restore(backup(p))).toThrow()
  p.days[0].ranges[0].end=0
  p.visits[0].dayId='absent'
  expect(()=>restore(backup(p))).toThrow()
})
