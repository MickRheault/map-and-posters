import {layout, type Point} from './track'
import {combinedRanges,dayName,dayTrack,insertRestDay,joinDays,moveRecording,possibleOverlap,setBoundary,type Day,type Itinerary,type PointRef} from './itinerary'

function element<K extends keyof HTMLElementTagNameMap>(tag:K,text='') {
  const node=document.createElement(tag)
  node.textContent=text
  return node
}
function button(label:string,action:()=>void,disabled=false) {
  const node=element('button',label)
  node.type='button'
  node.disabled=disabled
  node.onclick=action
  return node
}
function option(label:string,value:string) {
  const choice=element('option',label)
  choice.value=value
  return choice
}
function labeled(name:string,field:HTMLElement) {
  const label=element('label',name+' ')
  label.append(field)
  return label
}
function svgNode<K extends keyof SVGElementTagNameMap>(tag:K,attrs:Record<string,string>):SVGElementTagNameMap[K] {
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag)
  for(const [key,value] of Object.entries(attrs)) node.setAttribute(key,value)
  return node
}

type Sample=PointRef & {x:number,y:number,km:number,ele:number|null,run:number}

function boundaryEditor(project:Itinerary,left:Day,right:Day|null,commit:()=>void) {
  const panel=element('fieldset')
  panel.append(element('legend',right?'Adjust day boundary':'Split this day'))
  const ranges=combinedRanges(right?[left,right]:[left])
  const sources=new Map(project.recordings.map(r=>[r.id,r]))
  const samples:Sample[]=[]
  const segments:Point[][]=[]
  const visible=ranges.filter(r=>sources.get(r.recordingId)?.included)
  for(const r of visible) segments.push(sources.get(r.recordingId)!.track[r.segment].slice(r.start,r.end+1))
  if (!segments.length) { panel.append('Include a recording to edit this day.'); return panel }
  const bounds=layout(segments)
  const scale=Math.min(372/(bounds.east-bounds.west || 1e-8),172/(bounds.north-bounds.south || 1e-8))
  const projectAxis=(x:number,center:number,offset:number)=>offset+(x-center)*scale
  bounds.lines.forEach((line,run)=>{
    const r=visible[run]
    line.forEach((p,i)=>samples.push({
      recordingId:r.recordingId,segment:r.segment,point:r.start+i,run,km:p.km,ele:p.ele,
      x:projectAxis(p.x,(bounds.east+bounds.west)/2,200),
      y:projectAxis(-p.y,-(bounds.north+bounds.south)/2,100)
    }))
  })
  if(samples.length<3) { panel.append('A day needs at least one point on each side of a split.'); return panel }

  const map=svgNode('svg',{viewBox:'0 0 400 200','aria-label':'Choose a boundary on the recorded route'})
  const profile=svgNode('svg',{viewBox:'0 0 400 80','aria-label':'Choose a boundary on the elevation profile'})
  map.style.cssText=profile.style.cssText='width:100%;height:auto;cursor:crosshair;background:#f2f2e8;display:block'
  const slider=element('input')
  slider.type='range'
  slider.min='1'
  slider.max=String(samples.length-2)
  slider.step='1'
  const endpoint=left.ranges.at(-1)
  let split=right && endpoint ? samples.findIndex(p=>p.recordingId===endpoint.recordingId && p.segment===endpoint.segment && p.point===endpoint.end) : -1
  if(split<1 || split>=samples.length-1) split=Math.floor(samples.length/2)
  const summary=element('output')
  const passes=element('select')
  const passLabel=labeled('Matching visits',passes)
  passLabel.hidden=true
  const beforeColor=left.color,afterColor=right?.color || '#777464'
  const xy=(q:Sample)=>q.x.toFixed(1)+','+q.y.toFixed(1)
  const elevation=(q:Sample)=>(10+380*q.km/(bounds.km||1)).toFixed(1)+','+(70-60*(q.ele!-bounds.low)/(bounds.peak-bounds.low||1)).toFixed(1)
  function draw() {
    slider.value=String(split)
    const chosen=samples[split]
    summary.textContent=chosen.km.toFixed(1)+' km before boundary · '+(bounds.km-chosen.km).toFixed(1)+' km after'
    map.replaceChildren()
    profile.replaceChildren()
    let mapPath='',profilePath='',previousColor='',previousRun=-1,previousElevation=false
    function flush() {
      const attrs={fill:'none',stroke:previousColor,'stroke-width':'3','stroke-linejoin':'round','stroke-linecap':'round'}
      if(mapPath) map.prepend(svgNode('path',{...attrs,d:mapPath}))
      if(profilePath) profile.append(svgNode('path',{...attrs,d:profilePath}))
    }
    for(let i=0;i<samples.length;i++) {
      const p=samples[i],color=i<=split?beforeColor:afterColor
      if (p.run!==previousRun || color!==previousColor) {
        flush()
        const prev=i>0 && samples[i-1].run===p.run?samples[i-1]:null
        mapPath=prev?'M'+xy(prev):''
        profilePath=prev && prev.ele!==null?'M'+elevation(prev):''
        previousElevation=Boolean(profilePath)
      }
      mapPath+=(mapPath?'L':'M')+xy(p)
      if(p.ele!==null) profilePath+=(previousElevation?'L':'M')+elevation(p)
      previousElevation=p.ele!==null
      previousRun=p.run
      previousColor=color
    }
    flush()
    map.append(svgNode('circle',{cx:String(chosen.x),cy:String(chosen.y),r:'5',fill:'#fff',stroke:'#212d24','stroke-width':'2'}))
    const profileX=String(10+380*chosen.km/(bounds.km||1))
    profile.append(svgNode('line',{x1:profileX,x2:profileX,y1:'4',y2:'76',stroke:'#212d24','stroke-dasharray':'3 2'}))
  }
  function change(value:number) {split=Math.max(1,Math.min(samples.length-2,value)); draw()}
  slider.oninput=()=>{passLabel.hidden=true; change(Number(slider.value))}
  const pointer=(ev:MouseEvent,svg:SVGSVGElement,height:number)=>{
    const rect=svg.getBoundingClientRect()
    return {x:(ev.clientX-rect.left)/rect.width*400,y:(ev.clientY-rect.top)/rect.height*height}
  }
  map.onclick=ev=>{
    const location=pointer(ev,map,200)
    const ds=samples.map(p=>Math.hypot(p.x-location.x,p.y-location.y))
    let best=Infinity
    for(let i=1;i<ds.length-1;i++) best=Math.min(best,ds[i])
    // Each local distance minimum identifies one approach, including short
    // out-and-back detours that never leave the pointer's hit radius.
    const candidates:number[]=[]
    for(let i=1;i<ds.length-1;i++){
      if(ds[i]>best+3) continue
      const first=i
      while(i+1<ds.length-1 && samples[i+1].run===samples[first].run && Math.abs(ds[i+1]-ds[first])<1e-6) i++
      const before=first===1 || samples[first-1].run!==samples[first].run ? Infinity : ds[first-1]
      const after=i===ds.length-2 || samples[i+1].run!==samples[first].run ? Infinity : ds[i+1]
      if(ds[first]<=before && ds[first]<=after) candidates.push(first)
    }
    if(!candidates.length) return
    passes.replaceChildren(...candidates.map((i,n)=>option('Pass '+(n+1)+' · '+samples[i].km.toFixed(1)+' km · '+sources.get(samples[i].recordingId)!.name,String(i))))
    passLabel.hidden=candidates.length<2
    change(candidates[0])
  }
  passes.onchange=()=>change(Number(passes.value))
  const pickOnProfile=(ev:MouseEvent)=>{
    const km=(pointer(ev,profile,80).x-10)/380*bounds.km
    let closest=1
    for(let i=2;i<samples.length-1;i++) if(Math.abs(samples[i].km-km)<Math.abs(samples[closest].km-km)) closest=i
    passLabel.hidden=true
    change(closest)
  }
  profile.onclick=pickOnProfile
  profile.style.touchAction='none'
  profile.onpointerdown=ev=>{
    profile.setPointerCapture(ev.pointerId)
    pickOnProfile(ev)
  }
  profile.onpointermove=ev=>{
    if(profile.hasPointerCapture(ev.pointerId)) pickOnProfile(ev)
  }
  profile.onpointerup=ev=>{
    if(profile.hasPointerCapture(ev.pointerId)) profile.releasePointerCapture(ev.pointerId)
  }
  const apply=button(right?'Apply boundary':'Create next day',()=>{
    try {setBoundary(project,left,right,samples[split]);commit()} catch(e){summary.textContent=(e as Error).message}
  })
  panel.append(map)
  if(Number.isFinite(bounds.peak)) panel.append(profile)
  panel.append(labeled('Boundary point',slider),passLabel,summary,apply)
  draw()
  return panel
}

export function mountItinerary(host:HTMLElement,project:Itinerary,onChange:()=>void,onMerge?:(removed:string,kept:string)=>void) {
  host.replaceChildren()
  function commit(){mountItinerary(host,project,onChange,onMerge); onChange()}
  if(!project.recordings.length && !project.days.length) {
    host.append(button('Add a rest day',()=>{insertRestDay(project,0);commit()}))
    return
  }
  if(project.recordings.length) host.append(element('h3','Recordings'))
  project.recordings.forEach((rec,i)=>{
    const row=element('div')
    row.className='recording-row'
    const checkbox=element('input')
    checkbox.type='checkbox'; checkbox.checked=rec.included
    checkbox.onchange=()=>{rec.included=checkbox.checked;commit()}
    const label=element('label');label.append(checkbox,' '+rec.name)
    const up=button('↑',()=>{moveRecording(project,i,-1);commit()},i===0)
    const down=button('↓',()=>{moveRecording(project,i,1);commit()},i===project.recordings.length-1)
    up.setAttribute('aria-label','Move '+rec.name+' earlier')
    down.setAttribute('aria-label','Move '+rec.name+' later')
    row.append(label,up,down)
    const start=rec.track[0]?.[0]?.time
    if(start) row.append(element('small',start))
    const overlaps=project.recordings.slice(0,i).filter(other=>possibleOverlap(rec,other))
    if(overlaps.length) row.append(element('small','Possible overlap with '+overlaps.map(r=>r.name).join(', ')))
    host.append(row)
  })
  host.append(element('h3','Itinerary'))
  const selector=element('select')
  project.days.forEach(day=>selector.add(option(dayName(project,day)+(day.date?' · '+day.date:''),day.id)))
  const previous=host.dataset.day
  if(previous && project.days.some(d=>d.id===previous))selector.value=previous
  const detail=element('div')
  host.append(labeled('Edit day',selector),detail)
  function show() {
    detail.replaceChildren()
    const index=project.days.findIndex(d=>d.id===selector.value),day=project.days[index]
    if(!day) return
    host.dataset.day=day.id
    const name=element('input')
    name.type='text';name.value=day.name;name.maxLength=80
    name.onchange=()=>{day.name=name.value.trim();commit()}
    const color=element('input')
    color.type='color'
    color.value=day.color
    color.onchange=()=>{day.color=color.value;commit()}
    detail.append(labeled('Day name',name), labeled('Day colour',color))
    const addRest=(offset:number)=>{
      const rest=insertRestDay(project,index+offset)
      host.dataset.day=rest.id
      commit()
    }
    detail.append(button('Rest day before',()=>addRest(0)),button('Rest day after',()=>addRest(1)))
    if(day.rest) return
    const track=dayTrack(project,day)
    if(track.length) detail.append(element('p',layout(track).km.toFixed(1)+' km'))
    const mode=element('select')
    mode.add(option('Split this day','split'))
    const nextIndex=project.days.findIndex((d,i)=>i>index && !d.rest)
    const next=project.days[nextIndex]
    if(next) mode.add(option('Adjust boundary with '+dayName(project,next),'adjust'))
    const editor=element('div')
    function edit(){editor.replaceChildren(boundaryEditor(project,day,mode.value==='adjust'?next:null,commit))}
    mode.onchange=edit
    detail.append(labeled('Day boundaries',mode),editor)
    if(nextIndex===index+1) detail.append(button('Group with next day',()=>{
      joinDays(project,day,next);onMerge?.(next.id,day.id);commit()
    }))
    edit()
  }
  selector.onchange=show
  show()
}
