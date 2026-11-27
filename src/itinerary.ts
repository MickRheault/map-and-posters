import {parseTrack, type Track} from './track'

export type Recording = {id:string, name:string, xml:string, track:Track, included:boolean, importIndex?:number}
export type Range = {recordingId:string, segment:number, start:number, end:number}
export type Day = {id:string, name:string, color:string, rest:boolean, ranges:Range[], date?:string}
export type Itinerary = {recordings:Recording[], days:Day[], manualOrder?:boolean}

const palette = ['#aa4839','#25678a','#7760a2','#167c79','#a15513','#8f4466','#4e7040','#4f5899']
function newDay(project:Itinerary,rest=false):Day {
  const unused = palette.find(color => !project.days.some(day => day.color === color))
  return {id:crypto.randomUUID(),name:rest?'Rest day':'',color:unused || palette[project.days.length%palette.length],rest,ranges:[]}
}

export function dayName(project:Itinerary,day:Day) {
  return 'Day '+(project.days.indexOf(day)+1)+(day.name?' · '+day.name:'')
}

function firstTimestamp(track:Track) {
  let first = NaN, previous = -Infinity
  for (const segment of track) for (const point of segment) {
    const time = point.time
    if (!time || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(time)) return NaN
    const stamp = Date.parse(time)
    if (!Number.isFinite(stamp) || stamp < previous) return NaN
    if (!Number.isFinite(first)) first = stamp
    previous = stamp
  }
  return first
}

const startTimes=new WeakMap<Track,number>()
function reliableStart(track:Track) {
  if (!startTimes.has(track)) startTimes.set(track,firstTimestamp(track))
  return startTimes.get(track)!
}

export function importRecording(project:Itinerary,xml:string,name:string,document?:Document) {
  const recording:Recording = {id:crypto.randomUUID(),name,xml,track:parseTrack(document ?? xml),included:true}
  appendRecording(project,recording)
  return recording
}

export function appendRecording(project:Itinerary,recording:Recording) {
  const first = reliableStart(recording.track)
  project.recordings.forEach((r,i)=>{r.importIndex ??= i})
  recording.importIndex=project.recordings.length
  project.recordings.push(recording)
  // A timestamp proposal may order new files. Existing manual choices always take precedence.
  const chronological=project.recordings.every(r=>Number.isFinite(reliableStart(r.track)))
  if (!project.manualOrder) {
    project.recordings.sort((a,b)=>chronological
      ? reliableStart(a.track)-reliableStart(b.track) : a.importIndex!-b.importIndex!)
  }
  const byDate = new Map<string,Day>()
  function addRange(segment:number,start:number,end:number,date:string) {
    let day = byDate.get(date)
    if (!day && date && !project.manualOrder) day = project.days.find(d => d.date===date && !d.rest)
    if (!day) {
      day = newDay(project)
      if (date) day.date = date
      project.days.push(day)
    }
    byDate.set(date,day)
    day.ranges.push({recordingId:recording.id,segment,start,end})
  }
  recording.track.forEach((points,segment)=>{
    let start=0
    let date=Number.isFinite(first) ? points[0].time!.slice(0,10) : ''
    for(let i=1;i<points.length;i++){
      const next=date ? points[i].time!.slice(0,10) : ''
      if (next!==date) {
        addRange(segment,start,i-1,date)
        start=i-1
        date=next
      }
    }
    addRange(segment,start,points.length-1,date)
  })
  orderRanges(project)
  if (!project.manualOrder) {
    if(chronological) project.days.sort((a,b)=>a.date!.localeCompare(b.date!))
    else orderTravelDays(project)
  }
}

function orderRanges(project:Itinerary) {
  const order = new Map(project.recordings.map((r,i)=>[r.id,i]))
  for(const day of project.days) day.ranges.sort((a,b)=>
    order.get(a.recordingId)!-order.get(b.recordingId)! || a.segment-b.segment || a.start-b.start)
}

function orderTravelDays(project:Itinerary) {
  // Reorder the travel days, preserving explicit rest-day slots.
  const order = new Map(project.recordings.map((r,i)=>[r.id,i]))
  const travel=project.days.filter(d=>!d.rest)
  travel.sort((a,b)=>(order.get(a.ranges[0].recordingId)!-order.get(b.ranges[0].recordingId)!))
  let i=0
  project.days=project.days.map(d=>d.rest?d:travel[i++])
}

export function moveRecording(project:Itinerary,index:number,delta:number) {
  const next=index+delta
  if (index<0 || next<0 || index>=project.recordings.length || next>=project.recordings.length) return
  const [recording]=project.recordings.splice(index,1)
  project.recordings.splice(next,0,recording)
  orderRanges(project)
  orderTravelDays(project)
  project.manualOrder=true
}

export function dayTrack(project:Itinerary,day:Day):Track {
  const sources=new Map(project.recordings.map(r=>[r.id,r]))
  return day.ranges.flatMap(r=>{
    const src=sources.get(r.recordingId)
    return src?.included ? [src.track[r.segment].slice(r.start,r.end+1)] : []
  })
}

export function insertRestDay(project:Itinerary,index:number,name='Rest day') {
  const day=newDay(project,true)
  day.name=name.trim() || 'Rest day'
  project.days.splice(index,0,day)
  project.manualOrder=true
  return day
}

export function removeDay(project:Itinerary,day:Day) {
  const index=project.days.indexOf(day)
  if(index<0) return false
  project.days.splice(index,1)
  project.manualOrder=true
  return true
}

// Adjacent days share a point when their boundary falls inside a recorded segment.
export function combinedRanges(days:Day[]):Range[] {
  const result:Range[]=[]
  for(const day of days) for(const range of day.ranges) {
    const last=result[result.length-1]
    if(last && last.recordingId===range.recordingId && last.segment===range.segment && last.end===range.start)
      last.end=range.end
    else result.push({...range})
  }
  return result
}

export function joinDays(project:Itinerary,left:Day,right:Day) {
  if(left.rest || right.rest || project.days.indexOf(left)+1!==project.days.indexOf(right))
    throw new Error('Select neighbouring travel days.')
  left.ranges=combinedRanges([left,right])
  project.days.splice(project.days.indexOf(right),1)
  project.manualOrder=true
}

export type PointRef={recordingId:string,segment:number,point:number}
export function splitRanges(ranges:Range[],ref:PointRef):[Range[],Range[]] {
  const index=ranges.findIndex(r=>r.recordingId===ref.recordingId && r.segment===ref.segment && ref.point>=r.start && ref.point<=r.end)
  if(index<0) throw new Error('Choose a point on the selected recording.')
  const r=ranges[index], left=ranges.slice(0,index), right=ranges.slice(index+1)
  if (ref.point>r.start || r.start===r.end) left.push({...r,end:ref.point})
  if (ref.point<r.end) right.unshift({...r,start:ref.point})
  if (!left.length || !right.length) throw new Error('Choose a boundary between the first and last points.')
  return [left,right]
}

export function setBoundary(project:Itinerary,left:Day,existingRight:Day|null,ref:PointRef) {
  const [before,after]=splitRanges(combinedRanges(existingRight?[left,existingRight]:[left]),ref)
  const right=existingRight || newDay(project)
  if (!existingRight) project.days.splice(project.days.indexOf(left)+1,0,right)
  left.ranges=before
  right.ranges=after
  project.manualOrder=true
  return right
}

const signatureCache=new WeakMap<Track,Set<string>>()
function signature(track:Track) {
  let signature=signatureCache.get(track)
  if (!signature) {
    signature=new Set()
    for(const segment of track) for(const p of segment) signature.add(p.lat.toFixed(3)+','+p.lon.toFixed(3))
    signatureCache.set(track,signature)
  }
  return signature
}

export function possibleOverlap(a:Recording,b:Recording) {
  const aCells=signature(a.track), bCells=signature(b.track)
  const [smaller,larger]=aCells.size<=bCells.size?[aCells,bCells]:[bCells,aCells]
  let matched=0
  for(const cell of smaller) if(larger.has(cell)) matched++
  return smaller.size>0 && matched/smaller.size>=0.25
}

export type MapSample={x:number,y:number,km:number,run:number}
export type PickPassesOptions={zoom?:number,hitMargin?:number,leaveMargin?:number}

// Hysteresis pass clustering collapses GPS jitter and tight switchback wiggles within
// one continuous visit into its closest point, starting a new pass only after the route
// leaves the click neighborhood by a clear margin and returns later.
export function pickBoundaryPasses(
  samples:readonly MapSample[],
  point:{x:number,y:number},
  options:PickPassesOptions={},
):number[] {
  if(samples.length<3) return []
  const zoom=Math.max(1,options.zoom ?? 1)
  const hitMargin=(options.hitMargin ?? 3)/zoom
  const leaveMargin=Math.max(hitMargin*2,(options.leaveMargin ?? 12)/zoom)
  const ds=samples.map(p=>Math.hypot(p.x-point.x,p.y-point.y))
  let best=Infinity
  for(let i=1;i<ds.length-1;i++) if(ds[i]<best) best=ds[i]
  if(!Number.isFinite(best)) return []
  const hitLimit=best+hitMargin
  const leaveLimit=best+leaveMargin
  const passes:number[]=[]
  let activeIndex=-1
  let activeDist=Infinity
  for(let i=1;i<ds.length-1;i++) {
    const d=ds[i]
    if(d<=hitLimit) {
      if(activeIndex<0 || d<activeDist) { activeIndex=i; activeDist=d }
    } else if(activeIndex>=0 && d>leaveLimit) {
      passes.push(activeIndex)
      activeIndex=-1
      activeDist=Infinity
    }
  }
  if(activeIndex>=0) passes.push(activeIndex)
  return passes
}

export type MapView={zoom:number,x:number,y:number}
export const MAX_MAP_ZOOM=16

export function clampMapView(view:MapView,width=400,height=200):MapView {
  const zoom=Math.max(1,Math.min(MAX_MAP_ZOOM,Number.isFinite(view.zoom)?view.zoom:1))
  const vw=width/zoom, vh=height/zoom
  const x=Math.max(0,Math.min(width-vw,Number.isFinite(view.x)?view.x:0))
  const y=Math.max(0,Math.min(height-vh,Number.isFinite(view.y)?view.y:0))
  return {zoom,x,y}
}

export function zoomMapView(view:MapView,nextZoom:number,anchor:{x:number,y:number},width=400,height=200):MapView {
  const cur=clampMapView(view,width,height)
  const zoom=Math.max(1,Math.min(MAX_MAP_ZOOM,Number.isFinite(nextZoom)?nextZoom:cur.zoom))
  const curVw=width/cur.zoom, curVh=height/cur.zoom
  const nextVw=width/zoom, nextVh=height/zoom
  const rx=(anchor.x-cur.x)/curVw
  const ry=(anchor.y-cur.y)/curVh
  return clampMapView({zoom,x:anchor.x-rx*nextVw,y:anchor.y-ry*nextVh},width,height)
}

export function panMapView(
  view:MapView,
  dxPx:number,
  dyPx:number,
  rect:{width:number,height:number},
  width=400,
  height=200,
):MapView {
  const cur=clampMapView(view,width,height)
  if(cur.zoom<=1) return cur
  const vw=width/cur.zoom, vh=height/cur.zoom
  const sx=vw/(rect.width || width), sy=vh/(rect.height || height)
  return clampMapView({zoom:cur.zoom,x:cur.x-dxPx*sx,y:cur.y-dyPx*sy},width,height)
}

export function clientToMapPoint(
  rect:{left:number,top:number,width:number,height:number},
  view:MapView,
  clientX:number,
  clientY:number,
  width=400,
  height=200,
) {
  const cur=clampMapView(view,width,height)
  const vw=width/cur.zoom, vh=height/cur.zoom
  return {
    x:cur.x+(clientX-rect.left)/(rect.width || 1)*vw,
    y:cur.y+(clientY-rect.top)/(rect.height || 1)*vh,
  }
}
