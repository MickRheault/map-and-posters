import {expect,test} from 'bun:test'
import {appendRecording,combinedRanges,dayName,dayTrack,importRecording,insertRestDay,joinDays,moveRecording,possibleOverlap,removeDay,setBoundary,type Itinerary} from '../src/itinerary'
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
