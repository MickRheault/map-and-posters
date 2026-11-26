import {dayName, dayTrack, type Day} from './itinerary'
import {layout, type Track} from './track'
import type {Photo, Place} from './assets'
import type {Project} from './project'

export interface PosterTarget { key:string, name:string, days:Day[] }
export const escapeText=(value:string)=>value.replace(/[<>&"']/g,c=>'&#'+c.charCodeAt(0)+';')
const f=(value:number)=>value.toFixed(1)
const ink='#163b32', paper='#f8f5e9'
export function availablePosters(project:Project): PosterTarget[] {
  const included = new Set(project.recordings.filter(r=>r.included).map(r=>r.id))
  const days = project.days.filter(d=>d.rest || d.ranges.some(r=>included.has(r.recordingId)) ||
    project.photos.some(photo=>photo.dayId===d.id) || project.visits.some(v=>v.dayId===d.id))
  const result:PosterTarget[]=[{key:'trip',name:'Full trip',days}]
  for(const day of days) result.push({key:'day:'+day.id,name:dayName(project,day),days:[day]})
  for(const group of project.output.groups) {
    const members=days.filter(day=>group.dayIds.includes(day.id))
    if(members.length) result.push({key:'group:'+group.id,name:group.name,days:members})
  }
  return result
}
export function posterPlaces(project:Project,target:PosterTarget):Place[] {
  const visited = new Set(project.visits.filter(v=>target.days.some(d=>d.id===v.dayId)).map(v=>v.placeId))
  return project.places.filter(p=>target.key==='trip' || visited.has(p.id))
}
function placeText(project:Project,key:string,place:Place) {
  const mode=project.output.placeText?.[key]?.[place.id]
  if (mode==='pin') return ''
  if (mode==='category') return place.category
  if (mode==='both' && place.category) return place.name+' · '+place.category
  return place.name
}
function line(text:string,x:number,y:number,size:number,width:number,extra='') {
  const fit = Array.from(text).reduce((sum,c)=>sum+(/[il .,]/.test(c)?0.3:/[MW]/.test(c)?0.95:c.charCodeAt(0)>255?1:0.64),0)*size
  return '<text x="'+f(x)+'" y="'+f(y)+'" font-size="'+size+'" '+(fit>width?'textLength="'+width+'" lengthAdjust="spacingAndGlyphs" ':'')+extra+'>'+escapeText(text)+'</text>'
}
function picture(photo:Photo,x:number,y:number,width:number,height:number) {
  const scale=Math.max(width/photo.width,height/photo.height)*photo.zoom
  const w=photo.width*scale,h=photo.height*scale
  return '<svg x="'+x+'" y="'+y+'" width="'+width+'" height="'+height+'" overflow="hidden"><image x="'+f((width-w)*photo.cropX)+'" y="'+f((height-h)*photo.cropY)+'" width="'+f(w)+'" height="'+f(h)+'" href="'+escapeText(photo.src)+'"/></svg>'
}
function shade(hex:string,level:number) {
  const factor=1.23-level*.45
  const rgb=[1,3,5].map(pos=>Math.min(255,Math.round(parseInt(hex.slice(pos,pos+2),16)*factor)))
  return 'rgb('+rgb.join(',')+')'
}

function routeMap(project:Project,target:PosterTarget,tracks:Track[],places:Place[],top:number,height:number) {
  const segments=tracks.flat()
  // Single-point segments extend the bounds to the selected geographic pins without adding any distance.
  const all=segments.concat(places.map(p=>[{lat:p.lat,lon:p.lon,ele:null}]))
  if (!all.length) return ''
  const {lines,west,east,north,south}=layout(all)
  let peak=-Infinity,low=Infinity
  for (const recording of project.recordings) {
    if (!recording.included) continue
    for (const segment of recording.track) for (const point of segment) {
      if (point.ele !== null) {peak=Math.max(peak,point.ele);low=Math.min(low,point.ele)}
    }
  }
  const scale=Math.min(870/(east-west || 1e-9),(height-92)/(north-south || 1e-9))
  const xy=(p:{x:number,y:number})=>({x:540+(p.x-(east+west)/2)*scale,y:top+height/2-(p.y-(south+north)/2)*scale})
  let start=0
  const routes=tracks.map((track,i)=>{
    const day=target.days[i], pieces:string[]=[]
    for(const _segment of track) {
      const pts=lines[start++]
      let coords='', lastShade=''
      const finish=()=>{if(coords) pieces.push('<path d="'+coords+'" stroke="'+lastShade+'"/>')}
      for(let j=0;j<pts.length;j++){
        const p=pts[j], pos=xy(p), end=f(pos.x)+','+f(pos.y)
        if(pts.length===1){pieces.push('<circle cx="'+pos.x+'" cy="'+pos.y+'" r="4" fill="'+day.color+'"/>');break}
        if(!j){coords='M'+end;continue}
        const bucket=p.ele===null || peak===low ? .5 : Math.round(5*(p.ele-low)/(peak-low))/5
        const color=shade(day.color,bucket)
        if(lastShade && lastShade!==color) {
          finish()
          const prev=xy(pts[j-1])
          coords='M'+f(prev.x)+','+f(prev.y)
        }
        lastShade=color
        coords+=' L'+end
      }
      finish()
    }
    return '<g data-route="'+escapeText(day.id)+'">'+pieces.join('')+'</g>'
  })
  let pins=''
  const labelLocations:{x:number,y:number,width:number}[]=[]
  for(const [index,p] of places.entries()){
    const point=xy(lines[segments.length+index][0])
    const name=placeText(project,target.key,p)
    const width=Math.min(540,Math.max(55,name.length*17))
    const override=project.output.labels[target.key]?.[p.id]
    const x=Math.max(40,Math.min(1040-width,override?.x ?? point.x+13))
    let y=Math.max(top+32,Math.min(top+height-8,override?.y ?? point.y-11))
    if(!override){
      const margin=32
      const origin=y
      for(let i=0;i<Math.floor(height/margin);i++){
        const candidate=origin+(i%2?1:-1)*Math.ceil(i/2)*margin
        if(candidate<top+32 || candidate>top+height-8) continue
        if(!labelLocations.some(l=>Math.abs(l.y-candidate)<margin && x<l.x+l.width && x+width>l.x)) {y=candidate;break}
      }
    }
    if(name) labelLocations.push({x,y,width})
    const overnight=project.visits.some(v=>v.placeId===p.id && v.overnight && target.days.some(d=>d.id===v.dayId))
    if(name) pins+='<path stroke="#5d6b60" fill="none" d="M'+f(point.x)+','+f(point.y)+' L'+f(x)+','+f(y-8)+'"/>'
    pins+='<circle cx="'+f(point.x)+'" cy="'+f(point.y)+'" r="7" fill="'+ink+'" stroke="'+paper+'" stroke-width="3"/>'
    if(name) pins+=line(name,x,y,27,width,'data-label="'+escapeText(p.id)+'" font-weight="'+(overnight?'700':'400')+'" stroke="'+paper+'" stroke-width="7" paint-order="stroke"')
  }
  return '<rect x="26" y="'+top+'" width="1028" height="'+height+'" rx="9" fill="#e7ebdd"/><g fill="none" stroke-width="6" stroke-linejoin="round" stroke-linecap="round">'+routes.reverse().join('')+'</g>'+pins
}

function elevation(stats:ReturnType<typeof layout>,top:number,color:string) {
  let paths=''
  for(const segment of stats.lines) {
    let active=false
    for(const p of segment) {
      if(p.ele===null){active=false;continue}
      const x=45+990*p.km/(stats.km || 1)
      const y=top+96-(p.ele-stats.low)/(stats.peak-stats.low || 1)*70
      paths+=(active?' L':' M')+f(x)+','+f(y)+(active?'':' l0.1,0')
      active=true
    }
  }
  return line('Elevation',45,top+25,25,300)+'<path d="'+paths+'" fill="none" stroke="'+color+'" stroke-width="4" stroke-linecap="round"/>'
}

export function renderPoster(project:Project,key='trip') {
  const target=availablePosters(project).find(t=>t.key===key)
  if (!target) throw Error('This poster is unavailable.')
  const {output}=project
  const tracks=target.days.map(day=>dayTrack(project,day)), combined=tracks.flat()
  const stats=combined.length ? layout(combined) : null
  const places=posterPlaces(project,target).filter(p=>output.placeVisibility?.[key]?.[p.id] ?? p.visible)
  const photos=project.photos.filter(p=>key==='trip' ? !p.dayId : target.days.some(d=>d.id===p.dayId))
  const hero=photos.find(p=>p.hero && (key!=='trip' || !p.dayId)) || photos.find(p=>p.hero) || photos[0]
  const gallery=photos.filter(p=>p!==hero)
  const title=output.title.trim() || 'Untitled trip'
  let body='',y=0
  if(hero){
    const height=combined.length?360:640
    body+=picture(hero,0,0,1080,height)+'<rect width="1080" height="'+height+'" fill="url(#scrim)"/>'
    body+=line(title,48,height-(key==='trip'?45:90),68,984,'fill="white" font-family="Georgia,serif" font-weight="bold"')
    if(key!=='trip') body+=line(target.name,48,height-38,38,984,'fill="white"')
    y=height+22
  }else{
    body+=line(title,48,94,68,984,'font-family="Georgia,serif" font-weight="bold"')
    if(key!=='trip') body+=line(target.name,48,150,38,984)
    y=key==='trip'?130:176
  }
  if(stats) {
    const height=hero?480:670
    body+=routeMap(project,target,tracks,places,y,height)
    y+=height+18
    if(output.showProfile && Number.isFinite(stats.peak)) {
      body+=elevation(stats,y,output.accent)
      y+=110
    }
    const metrics=[]
    if(output.showDistance) metrics.push(f(stats.km)+' km')
    if(output.showPeak && Number.isFinite(stats.peak)) metrics.push('Highest recorded · '+Math.round(stats.peak)+' m')
    if(metrics.length) {
      body+=line(metrics.join('     /     '),48,y+48,39,984,'font-weight="bold" fill="'+output.accent+'"')
      y+=77
    }
  }
  if(gallery.length) {
    const columns=gallery.length===1?1:Math.min(gallery.length,3), w=(984-(columns-1)*12)/columns
    for(const [i,photo] of gallery.entries()) {
      body+=picture(photo,48+(i%columns)*(w+12),y+Math.floor(i/columns)*208,w,196)
    }
    y+=Math.ceil(gallery.length/columns)*208+12
  }
  for(const day of target.days) {
    const visits=project.visits.filter(v=>v.dayId===day.id && places.some(p=>p.id===v.placeId))
    body+='<rect x="48" y="'+(y+10)+'" width="8" height="32" rx="4" fill="'+day.color+'"/>'
    body+=line(dayName(project,day),73,y+39,32,952)
    y+=53
    for (const visit of visits) {
      const place=places.find(p=>p.id===visit.placeId)!
      const name=placeText(project,key,place)
      if(!name) continue
      body+=line(name,75,y+27,31,952,'font-weight="'+(visit.overnight?'700':'400')+'"')
      y+=41
    }
  }
  if(output.credit) { body+=line(output.credit,48,y+44,27,980);y+=58 }
  const height=Math.max(780,Math.ceil(y+34))
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="'+height+'" viewBox="0 0 1080 '+height+'" role="img" aria-label="'+escapeText(title)+'" font-family="Arial,Helvetica,sans-serif" fill="'+ink+'"><defs><linearGradient id="scrim" x2="0" y2="1"><stop offset="0" stop-color="#071d15" stop-opacity="0"/><stop offset="1" stop-color="#071d15" stop-opacity=".82"/></linearGradient></defs><rect width="1080" height="'+height+'" fill="'+paper+'"/>'+body+'</svg>'
}
