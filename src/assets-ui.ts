import {addPlace, exportGpx, readCoordinates, readPhoto, type Assets, type Coordinates, type Photo, type Place, type Visit} from './assets'
import {distance} from './track'
import {dayName, type Day, type Itinerary} from './itinerary'

type AssetProject = Assets & Itinerary

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '') {
  const el=document.createElement(tag)
  if (text) el.textContent=text
  return el
}
function button(text: string, click: () => void) {
  const el=element('button',text)
  el.type='button'
  el.onclick=click
  return el
}
function label(text: string, control: HTMLElement) {
  const el=element('label')
  el.append(element('span',text),control)
  return el
}
function input(value: string, type = 'text') {
  const el=element('input')
  el.type=type
  el.value=value
  return el
}
function option(name:string, value:string) {
  const el=element('option',name)
  el.value=value
  return el
}
function select(options: [string,string][], value = '') {
  const el=element('select')
  for (const [id,name] of options) el.add(option(name,id))
  if (options.some(([id])=>id===value)) el.value=value
  return el
}
const openBoxes = new WeakMap<AssetProject, Set<string>>()

function details(text: string, project: AssetProject, key: string) {
  const el=element('details')
  el.append(element('summary',text))
  const state = openBoxes.get(project) || new Set<string>()
  openBoxes.set(project,state)
  el.open=state.has(key)
  el.addEventListener('toggle',()=>{
    if (!el.isConnected) return
    if (el.open) state.add(key); else state.delete(key)
  })
  return el
}

function pinMap(project: AssetProject, choose:(coords:Coordinates)=>void) {
  const ns='http://www.w3.org/2000/svg'
  const svg=document.createElementNS(ns,'svg')
  svg.setAttribute('viewBox','0 0 360 220')
  svg.setAttribute('aria-label','Click the trip map to place a pin')
  svg.style.cssText='cursor:crosshair;background:#e1e8dc;width:100%;height:auto;box-shadow:none'
  const segments=project.recordings.filter(r=>r.included).flatMap(r=>r.track)
  const anchor=segments[0]?.[0]?.lon ?? project.places[0]?.lon ?? 0
  const relative=(lon:number)=>((lon-anchor+540)%360)-180
  let minLat=Infinity,maxLat=-Infinity,minLon=Infinity,maxLon=-Infinity
  function include(p:Coordinates) {
    const lon=relative(p.lon)
    minLat=Math.min(minLat,p.lat); maxLat=Math.max(maxLat,p.lat)
    minLon=Math.min(minLon,lon); maxLon=Math.max(maxLon,lon)
  }
  for (const segment of segments) for (const p of segment) include(p)
  project.places.forEach(include)
  if (!Number.isFinite(minLat)) {minLat=-90;maxLat=90;minLon=-180;maxLon=180}
  const midLat=(maxLat+minLat)/2, midLon=(maxLon+minLon)/2
  const longitudeScale=Math.max(0.01,Math.cos(midLat*Math.PI/180))
  const scale=Math.min(320/Math.max(0.005,(maxLon-minLon)*longitudeScale),180/Math.max(0.005,maxLat-minLat))
  const x=(p:Coordinates)=>180+(relative(p.lon)-midLon)*scale*longitudeScale
  const y=(p:Coordinates)=>110-(p.lat-midLat)*scale
  for (const segment of segments) {
    const path=document.createElementNS(ns,'path')
    path.setAttribute('d',segment.map((p,i)=>(i?'L':'M')+x(p).toFixed(2)+' '+y(p).toFixed(2)).join(' '))
    path.setAttribute('fill','none'); path.setAttribute('stroke','#366657'); path.setAttribute('stroke-width','1.6')
    svg.append(path)
  }
  for (const p of project.places) {
    const dot=document.createElementNS(ns,'circle')
    dot.setAttribute('cx',String(x(p))); dot.setAttribute('cy',String(y(p))); dot.setAttribute('r','3')
    dot.setAttribute('fill','#ad4725')
    const title=document.createElementNS(ns,'title');title.textContent=p.name;dot.append(title);svg.append(dot)
  }
  svg.onclick=event=>{
    const transform=svg.getScreenCTM()
    if (!transform) return
    const pixel=new DOMPoint(event.clientX,event.clientY).matrixTransform(transform.inverse())
    choose({lat:Math.max(-90,Math.min(90,midLat-(pixel.y-110)/scale)),lon:((anchor+midLon+(pixel.x-180)/(scale*longitudeScale)+540)%360)-180})
  }
  return svg
}

// Each local minimum is a distinct candidate, even when two passes share coordinates.
export function visitCandidates(project:AssetProject,day:Day,place:Place) {
  const options:{km:number,position:NonNullable<Visit['position']>}[]=[]
  const records=new Map(project.recordings.filter(r=>r.included).map(r=>[r.id,r]))
  const target={lat:place.lat,lon:place.lon,ele:null}
  for(const range of day.ranges) {
    const line=records.get(range.recordingId)?.track[range.segment]
    if(!line) continue
    let previous=Infinity
    let current=distance(target,line[range.start])
    for(let i=range.start;i<=range.end;i++) {
      const next=i<range.end?distance(target,line[i+1]):Infinity
      if(current<previous && current<=next) options.push({km:current,position:{recordingId:range.recordingId,segment:range.segment,point:i}})
      previous=current;current=next
    }
  }
  const closest=options.reduce((min,o)=>Math.min(min,o.km),Infinity)
  return options.filter(o=>o.km<=closest+0.5)
}

export type AssetsSection = 'all' | 'places' | 'photos'

export function mountAssets(host:HTMLElement,project:AssetProject,onChange:()=>void,section:AssetsSection='all') {
  host.replaceChildren()
  const placesPanel=element('section'),photosPanel=element('section')
  if (section !== 'photos') host.append(placesPanel)
  if (section !== 'places') host.append(photosPanel)
  const dayOptions=():[string,string][]=>project.days.map(d=>[d.id,dayName(project,d)])
  const rerender=()=>{onChange(); if (host.contains(placesPanel) || host.contains(photosPanel)) mountAssets(host,project,onChange,section)}
  placesPanel.append(element('h3','Places & visits'))
  const name=input(''),location=input(''),notice=element('p')
  location.placeholder='Latitude, longitude or map link'
  notice.setAttribute('role','status')
  const mapBox=details('Drop a pin on the map',project,'map')
  mapBox.ontoggle=()=>{
    if (!mapBox.open || mapBox.querySelector('svg')) return
    mapBox.append(pinMap(project,coords=>{
      location.value=coords.lat.toFixed(7)+', '+coords.lon.toFixed(7)
      notice.textContent='Pin positioned. Choose Add place to save.'
    }))
  }
  placesPanel.append(label('Place name',name),label('Location',location),mapBox,button('Add place',()=>{
    const coords=readCoordinates(location.value)
    if (!coords) {
      mapBox.open=true
      notice.textContent='Paste a coordinate pair or click the map to position this place.'
      return
    }
    addPlace(project,name.value,coords)
    rerender()
  }),notice)
  for (const place of project.places) {
    const box=details(place.name,project,place.id)
    const visible=input('','checkbox');visible.checked=place.visible
    visible.onchange=()=>{place.visible=visible.checked;rerender()}
    const placeName=input(place.name)
    placeName.onchange=()=>{place.name=placeName.value.trim() || place.name; rerender()}
    const category=input(place.category)
    category.onchange=()=>{place.category=category.value.trim() || 'Place';rerender()}
    box.append(label('Show on posters and in waypoint export',visible),label('Name',placeName),label('Category',category),
      element('small',place.lat.toFixed(5)+', '+place.lon.toFixed(5)))
    for(const visit of project.visits.filter(v=>v.placeId===place.id)){
      const day=project.days.find(d=>d.id===visit.dayId)
      const row=element('div')
      row.append(element('span',(day ? dayName(project,day) : 'Unassigned day')+(visit.overnight?' · Overnight':' · Visit')+(visit.position?' · Point '+(visit.position.point+1):'')),
        button('Remove visit',()=>{project.visits=project.visits.filter(v=>v.id!==visit.id);rerender()}))
      box.append(row)
    }
    if(project.days.length) {
      const day=select(dayOptions()),overnight=input('','checkbox'),position=element('select')
      let refs:NonNullable<Visit['position']>[]=[]
      function options() {
        const selected=project.days.find(d=>d.id===day.value)!
        const ranges=selected.ranges.filter(r=>project.recordings.some(rec=>rec.id===r.recordingId && rec.included))
        const end=ranges.at(-1)
        refs=[]; position.replaceChildren(option('Day only',''))
        if(end) {
          refs.push({recordingId:end.recordingId,segment:end.segment,point:end.end})
          position.add(option('End of day · point '+(end.end+1),'0'))
        }
        for(const pass of visitCandidates(project,selected,place)) {
          refs.push(pass.position)
          const record=project.recordings.find(r=>r.id===pass.position.recordingId)!
          position.add(option(record.name+' · segment '+(pass.position.segment+1)+' · point '+(pass.position.point+1)+' · '+pass.km.toFixed(1)+' km away',String(refs.length-1)))
        }
        if(overnight.checked && end) position.value='0'
      }
      // Calculate pass choices when a place is opened, including keyboard interaction.
      box.ontoggle=()=>{if(box.open) options()}
      day.onchange=options
      overnight.onchange=()=>{if(overnight.checked && refs.length) position.value='0'}
      box.append(label('Visit day',day),label('Trip position',position),label('Overnight stay',overnight),button('Add visit',()=>{
        project.visits.push({id:crypto.randomUUID(),placeId:place.id,dayId:day.value,overnight:overnight.checked,
          position:position.value ? refs[Number(position.value)] : undefined})
        rerender()
      }))
    }
    box.append(button('Remove place',()=>{
      project.places=project.places.filter(p=>p.id!==place.id)
      project.visits=project.visits.filter(v=>v.placeId!==place.id)
      for(const photo of project.photos) if(photo.placeId===place.id) delete photo.placeId
      rerender()
    }))
    placesPanel.append(box)
  }
  const saveGpx=button('Download GPX with selected places',()=>{
    const url=URL.createObjectURL(new Blob([exportGpx(project.places,project.recordings)],{type:'application/gpx+xml'}))
    const a=element('a');a.href=url;a.download='trip-with-places.gpx';a.click()
    setTimeout(()=>URL.revokeObjectURL(url),60000)
  })
  saveGpx.disabled=!project.places.some(p=>p.visible)
  placesPanel.append(saveGpx)
  photosPanel.append(element('h3','Photos'))
  const photoDays:[string,string][]=[['','Full trip'],...dayOptions()]
  const assignment=select(photoDays),files=input('','file'),photoStatus=element('p')
  photoStatus.setAttribute('role','status')
  files.multiple=true;files.accept='image/jpeg,image/png,.jpg,.jpeg,.png'
  files.onchange=async()=>{
    const batch=Array.from(files.files || [])
    if(!batch.length) return
    const dayId=assignment.value
    files.disabled=true
    const loaded:Photo[]=[],errors:string[]=[]
    for(const [i,file] of batch.entries()){
      photoStatus.textContent='Preparing photo '+(i+1)+' of '+batch.length+'…'
      try { loaded.push(await readPhoto(file,dayId)) } catch { errors.push(file.name) }
    }
    project.photos.push(...loaded)
    files.disabled=false;files.value=''
    if(loaded.length) rerender()
    const status=host.querySelector('[data-photo-status]') || photoStatus
    status.textContent=errors.length?'Could not read '+errors.join(', ')+'. Choose JPEG or PNG files.':loaded.length+' photos added.'
  }
  photoStatus.dataset.photoStatus=''
  photosPanel.append(label('Add photos to',assignment),label('Choose photos',files),photoStatus)
  for(const [i,photo] of project.photos.entries()) {
    const box=details(photo.name,project,photo.id),thumb=element('img')
    thumb.src=photo.src;thumb.alt=photo.name;thumb.loading='lazy';thumb.width=120
    const day=select(photoDays,photo.dayId)
    day.onchange=()=>{photo.dayId=day.value;photo.hero=false;rerender()}
    const hero=input('','checkbox');hero.checked=photo.hero
    hero.onchange=()=>{
      if(hero.checked) for(const sibling of project.photos) if(sibling.dayId===photo.dayId) sibling.hero=false
      photo.hero=hero.checked;rerender()
    }
    box.append(thumb,label('Assigned to',day),label('Use as lead photo',hero))
    function cropControl(title:string,key:'cropX'|'cropY'|'zoom',min:number,max:number) {
      const slider=input(String(photo[key]),'range')
      slider.min=String(min);slider.max=String(max);slider.step='0.01'
      slider.value=String(photo[key])
      slider.onchange=()=>{photo[key]=Number(slider.value);rerender()}
      return label(title,slider)
    }
    box.append(cropControl('Horizontal crop','cropX',0,1),cropControl('Vertical crop','cropY',0,1),cropControl('Crop zoom','zoom',1,3))
    function move(delta:number) {
      const next=i+delta
      const swap=button(delta<0?'Move photo earlier':'Move photo later',()=>{
        const [entry]=project.photos.splice(i,1);project.photos.splice(next,0,entry);rerender()
      })
      swap.disabled=next<0 || next>=project.photos.length
      return swap
    }
    box.append(move(-1),move(1))
    if(photo.gps && !photo.placeId) box.append(button('Add place from photo GPS',()=>{
      const place=addPlace(project,photo.name.replace(/\.[^.]+$/,''),photo.gps!)
      photo.placeId=place.id
      if(photo.dayId) project.visits.push({id:crypto.randomUUID(),placeId:place.id,dayId:photo.dayId,overnight:false})
      rerender()
    }))
    box.append(button('Remove photo',()=>{project.photos.splice(i,1);rerender()}))
    photosPanel.append(box)
  }
}
