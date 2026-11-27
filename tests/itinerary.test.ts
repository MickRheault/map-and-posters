import {expect,test} from 'bun:test'
import {appendRecording,clampMapView,clientToMapPoint,combinedRanges,dayName,dayTrack,importRecording,insertRestDay,joinDays,moveRecording,panMapView,pickBoundaryPasses,possibleOverlap,removeDay,setBoundary,zoomMapView,type Itinerary,type MapSample} from '../src/itinerary'
import {mountItinerary} from '../src/itinerary-ui'
import {layout} from '../src/track'

const empty=():Itinerary=>({days:[],recordings:[]})
function recording(stamps:(string|null)[],lons=stamps.map((_,i)=>i)) {
  const points=stamps.map((stamp,i)=>`<trkpt lat="17" lon="${lons[i]}">${stamp?'<time>'+stamp+'</time>':''}</trkpt>`)
  return '<gpx><trk><trkseg>'+points.join('')+'</trkseg></trk></gpx>'
}
const stamp=(day:number,hour:number)=>`2026-11-${day}T${String(hour).padStart(2,'0')}:00:00+07:00`

test('chronological proposals order files, group same-date recordings and partition overnight traces',()=>{
  const p=empty()
  importRecording(p,recording([stamp(17,15),stamp(17,16)]),'afternoon')
  const r=importRecording(p,recording([stamp(16,23),stamp(17,1),stamp(17,2)]),'overnight')
  expect(p.recordings.map(r=>r.name)).toEqual(['overnight','afternoon'])
  expect(p.days.map(d=>d.date)).toEqual(['2026-11-16','2026-11-17'])
  expect(dayTrack(p,p.days[1]).map(seg=>seg.length)).toEqual([3,2])
  const total=p.days.reduce((n,d)=>n+layout(dayTrack(p,d)).km,0)
  expect(total).toBeCloseTo(layout(r.track).km+layout(p.recordings[1].track).km)
})

test('unreliable or absent timestamps retain import order and offer duplicate review without discarding repeats',()=>{
  const p=empty()
  const xml=recording([stamp(17,14),null,stamp(17,13)])
  const a=importRecording(p,xml,'first'), b=importRecording(p,xml,'second')
  expect(p.days.length).toBe(2)
  expect(p.recordings).toEqual([a,b])
  expect(possibleOverlap(a,b)).toBe(true)
  b.included=false
  expect(dayTrack(p,p.days[1])).toEqual([])
  expect(b.xml).toBe(xml)
  b.included=true
  moveRecording(p,1,-1)
  expect(p.recordings[0]).toBe(b)
  expect(p.days[0].ranges[0].recordingId).toBe(b.id)
  joinDays(p,p.days[0],p.days[1])
  expect(layout(dayTrack(p,p.days[0])).km).toBeCloseTo(2*layout(a.track).km)
})

test('choosing an exact repeated pass moves the boundary while retaining stable source references',()=>{
  const p=empty()
  const source=importRecording(p,recording(Array(6).fill(null),[0,1,2,1,0,-1]),'out and back')
  const left=p.days[0], ref={recordingId:source.id,segment:0,point:1}
  const right=setBoundary(p,left,null,ref)
  const before=layout(dayTrack(p,left)).km
  setBoundary(p,left,right,{...ref,point:3})
  expect(layout(dayTrack(p,left)).km).toBeCloseTo(before*3)
  expect(layout(dayTrack(p,left)).km+layout(dayTrack(p,right)).km).toBeCloseTo(layout(source.track).km)
  expect(combinedRanges([left,right])).toEqual([{recordingId:source.id,segment:0,start:0,end:5}])
  const rest=insertRestDay(p,1,'Pai')
  expect(dayName(p,rest)).toBe('Day 2 · Pai')
  expect(dayTrack(p,rest)).toEqual([])
  expect(dayName(p,right)).toBe('Day 3')
})

test('a split at a recording gap retains segment geometry and original distance',()=>{
  const p=empty()
  appendRecording(p,{id:'a',name:'two segments',xml:'',included:true,track:[[0,1],[8,9]].map(seg=>seg.map(lon=>({lat:0,lon,ele:null})))})
  const right=setBoundary(p,p.days[0],null,{recordingId:'a',segment:0,point:1})
  expect(right.ranges).toEqual([{recordingId:'a',segment:1,start:0,end:1}])
  expect(layout(dayTrack(p,right)).km).toBeCloseTo(111.195,2)
  expect(()=>setBoundary(p,p.days[0],right,{recordingId:'a',segment:1,point:1})).toThrow()
})

test('editor can split a map-only GPX and insert a named rest day',()=>{
  const p=empty()
  importRecording(p,recording(Array(5).fill(null)),'test')
  const host=document.createElement('div')
  let changes=0
  mountItinerary(host,p,()=>{changes++})
  const click=(label:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===label)!.click()
  const slider=host.querySelector<HTMLInputElement>('input[type="range"]')!
  slider.value='3'
  slider.dispatchEvent(new Event('input'))
  click('Create next day')
  expect(p.days[0].ranges[0].end).toBe(3)
  click('Rest day after')
  expect(p.days.map(d=>d.rest)).toEqual([false,true,false])
  expect(changes).toBe(2)
})

test('map picks offer distinct passes and use the chosen visit as the day boundary',()=>{
  const p=empty()
  importRecording(p,recording(Array(6).fill(null),[-1,0,1,0,-1,-2]),'repeat')
  const host=document.createElement('div')
  mountItinerary(host,p,()=>{})
  const map=host.querySelector<SVGSVGElement>('svg')!
  Object.defineProperty(map,'getBoundingClientRect',{value:()=>({left:0,top:0,width:400,height:200})})
  map.dispatchEvent(new MouseEvent('click',{clientX:262,clientY:100}))
  const passes=Array.from(host.querySelectorAll('select')).find(select=>select.options[0]?.text.startsWith('Pass '))!
  expect(passes.options.length).toBe(2)
  passes.selectedIndex=1
  passes.dispatchEvent(new Event('change'))
  Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Create next day')!.click()
  expect(p.days[0].ranges[0].end).toBe(3)
})

test('a later file with no reliable times restores the original import sequence',()=>{
  const p=empty()
  importRecording(p,recording([stamp(18,12),stamp(18,13)]),'first')
  importRecording(p,recording([stamp(15,12),stamp(15,13)]),'second')
  expect(p.recordings.map(r=>r.name)).toEqual(['second','first'])
  importRecording(p,recording([null,null]),'third')
  expect(p.recordings.map(r=>r.name)).toEqual(['first','second','third'])
  expect(p.days.map(d=>d.ranges[0].recordingId)).toEqual(p.recordings.map(r=>r.id))
})

test('a photo-only rest day can start an itinerary before any GPX is imported',()=>{
  const p=empty(),host=document.createElement('div')
  mountItinerary(host,p,()=>{})
  host.querySelector('button')!.click()
  expect(p.days[0].rest).toBe(true)
  importRecording(p,recording([stamp(16,12),stamp(16,13)]),'next')
  expect(p.days.map(d=>d.rest)).toEqual([true,false])
})

test('removeDay deletes either a rest day or a riding day and marks manualOrder',()=>{
  const p=empty()
  importRecording(p,recording([stamp(16,12),stamp(16,13),stamp(16,14),stamp(16,15)]),'loop')
  setBoundary(p,p.days[0],null,{recordingId:p.recordings[0].id,segment:0,point:2})
  insertRestDay(p,1,'Pai')
  expect(p.days.map(d=>d.rest)).toEqual([false,true,false])
  removeDay(p,p.days[1])
  expect(p.days.map(d=>d.rest)).toEqual([false,false])
  removeDay(p,p.days[0])
  expect(p.days).toHaveLength(1)
  expect(p.manualOrder).toBe(true)
})

test('pickBoundaryPasses collapses switchback and GPS jitter into one visit while preserving real out-and-backs',()=>{
  // Dense noisy switchback / town zigzag around (200, 100) followed by a genuine return pass later
  const noisy:MapSample[]=[
    {x:100,y:100,km:0,run:0},
    {x:180,y:100,km:10,run:0},
    {x:199,y:100,km:12.0,run:0},
    {x:204,y:102,km:12.1,run:0},
    {x:200.2,y:100,km:12.2,run:0},
    {x:205,y:97,km:12.3,run:0},
    {x:199.5,y:101,km:12.4,run:0},
    {x:206,y:103,km:12.5,run:0},
    {x:201,y:99.5,km:12.6,run:0},
    {x:240,y:100,km:20,run:0},
    {x:320,y:100,km:40,run:0},
    // Genuine return visit with its own micro-jitter
    {x:201,y:100.5,km:60.0,run:0},
    {x:204,y:98,km:60.1,run:0},
    {x:200.1,y:100,km:60.2,run:0},
    {x:196,y:102,km:60.3,run:0},
    {x:199,y:100,km:60.4,run:0},
    {x:120,y:100,km:75,run:0},
  ]
  // Two genuine visits (indices 4 and 13), not 6 noisy micro-increments
  expect(pickBoundaryPasses(noisy,{x:200,y:100})).toEqual([4,13])

  // Single visit with jitter only -> collapses to a single best sample
  expect(pickBoundaryPasses(noisy.slice(0,11),{x:200,y:100})).toEqual([4])

  // Short genuine out-and-back spur that leaves the neighborhood (> 12 SVG units) still returns 2 passes
  const shortSpur:MapSample[]=[
    {x:150,y:100,km:0,run:0},
    {x:200,y:100,km:5,run:0},
    {x:216,y:100,km:6,run:0},
    {x:200,y:100,km:7,run:0},
    {x:150,y:100,km:12,run:0},
  ]
  expect(pickBoundaryPasses(shortSpur,{x:200,y:100})).toEqual([1,3])

  // Zooming in tightens hit/leave margins proportionally so close parallel passes can be resolved intentionally
  const tightLoop:MapSample[]=[
    {x:180,y:100,km:0,run:0},
    {x:200,y:100,km:1,run:0},
    {x:205,y:100,km:1.5,run:0},
    {x:200,y:100,km:2,run:0},
    {x:180,y:100,km:3,run:0},
  ]
  expect(pickBoundaryPasses(tightLoop,{x:200,y:100},{zoom:1})).toEqual([1])
  expect(pickBoundaryPasses(tightLoop,{x:200,y:100},{zoom:4})).toEqual([1,3])
})

test('Full editor map click collapses noisy switchbacks along one visit instead of showing Pass 1..N',()=>{
  const p=empty()
  // Route with tiny zigzag wiggles near lon=0.5 (all within ~5 SVG units)
  const pts=[
    [18,0],[18,0.48],[18.001,0.50],[17.999,0.508],[18.0005,0.501],
    [17.998,0.509],[18.0002,0.5005],[18,0.51],[18,1]
  ].map(([lat,lon])=>`<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('')
  importRecording(p,'<gpx><trk><trkseg>'+pts+'</trkseg></trk></gpx>','switchback')
  const host=document.createElement('div')
  mountItinerary(host,p,()=>{})
  const map=host.querySelector<SVGSVGElement>('svg')!
  Object.defineProperty(map,'getBoundingClientRect',{value:()=>({left:0,top:0,width:400,height:200})})
  map.dispatchEvent(new MouseEvent('click',{clientX:200,clientY:100}))
  const passes=Array.from(host.querySelectorAll('select')).find(select=>select.options[0]?.text.startsWith('Pass '))!
  expect(passes.options.length).toBe(1)
  expect(passes.closest('label')!.hidden).toBe(true)
})

test('map viewport helpers clamp zoom/pan bounds, anchor zoom, and map client clicks accurately',()=>{
  const base={zoom:1,x:0,y:0}
  const zoomed=zoomMapView(base,2,{x:200,y:100})
  expect(zoomed).toEqual({zoom:2,x:100,y:50})
  // Anchor near top-right stays under the cursor while clamping to bounds
  const corner=zoomMapView(base,4,{x:350,y:20})
  expect(corner.zoom).toBe(4)
  expect(corner.x).toBeGreaterThanOrEqual(0)
  expect(corner.x).toBeLessThanOrEqual(300)
  expect(corner.y).toBeGreaterThanOrEqual(0)
  expect(corner.y).toBeLessThanOrEqual(150)
  // Panning shifts viewBox opposite to drag delta and clamps within [0, 400-vw] x [0, 200-vh]
  const panned=panMapView(zoomed,-80,40,{width:400,height:200})
  expect(panned).toEqual({zoom:2,x:140,y:30})
  expect(clampMapView({zoom:2,x:-50,y:500})).toEqual({zoom:2,x:0,y:100})
  // Click at center of a zoomed & panned SVG maps to center of the active viewBox
  const pt=clientToMapPoint({left:10,top:20,width:400,height:200},panned,210,120)
  expect(pt.x).toBeCloseTo(240,5)
  expect(pt.y).toBeCloseTo(80,5)
})
