import type {Project} from './project'
import {availablePosters,escapeText,posterPlaces,renderPoster,type PosterTarget} from './poster'
import {zip} from './zip'
export {zip as zipFiles} from './zip'

export interface OutputState {
  title:string
  credit:string
  accent:string
  showDistance:boolean
  showPeak:boolean
  showProfile:boolean
  phone:boolean
  active:string
  format:'jpg'|'png'
  selected:string[]
  groups:{id:string,name:string,dayIds:string[]}[]
  labels:Record<string,Record<string,{x:number,y:number}>>
  placeVisibility:Record<string,Record<string,boolean>>
  placeText?:Record<string,Record<string,'name'|'category'|'both'|'pin'>>
}
export function defaultOutput():OutputState {
  return {title:'My trip',credit:'',accent:'#196952',showDistance:true,showPeak:true,showProfile:true,phone:false,
    active:'trip',format:'jpg',selected:['trip'],groups:[],labels:{},placeVisibility:{}}
}
function slug(name:string) {
  return name.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'').slice(0,80) || 'poster'
}
export function posterFiles(project:Project,targets:PosterTarget[]) {
  const names=new Set<string>()
  return targets.map(target=>{
    const base=slug(project.output.title)+'-'+slug(target.name)
    let name=base
    for(let n=2;names.has(name.toLowerCase());n++) name=base+'-'+n
    names.add(name.toLowerCase())
    return {target,name:name+'.'+project.output.format}
  })
}
export async function rasterize(svg:string,format:OutputState['format']):Promise<Blob> {
  const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}))
  const canvas=document.createElement('canvas')
  try {
    const image=new Image()
    image.src=url
    await image.decode()
    canvas.width=image.naturalWidth
    canvas.height=image.naturalHeight
    const ctx=canvas.getContext('2d')
    if(!ctx) throw Error('Image export is unavailable in this browser.')
    ctx.drawImage(image,0,0)
    const mime=format==='png'?'image/png':'image/jpeg'
    const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,mime,.94))
    if(!blob || blob.type!==mime) throw Error('The browser could not encode this poster.')
    return blob
  } finally {URL.revokeObjectURL(url);canvas.width=canvas.height=0}
}
function download(blob:Blob,name:string) {
  const a=document.createElement('a')
  a.href=URL.createObjectURL(blob);a.download=name
  document.body.append(a);a.click();a.remove()
  setTimeout(()=>URL.revokeObjectURL(a.href),60000)
}

export type OutputMode = 'full' | 'preview'

export function mountOutput(host:HTMLElement,project:Project,notify:()=>void,mode:OutputMode='full') {
  const onChange=()=>{mountOutput(host,project,notify,mode);notify()}
  const targets=availablePosters(project), state=project.output
  if(!project.days.length && !project.photos.length) {host.replaceChildren();return}
  const target=targets.find(t=>t.key===state.active) || targets[0]
  const eligible=posterPlaces(project,target)
  const checked=(v:boolean)=>v?' checked':''
  const options=targets.map(t=>'<option value="'+escapeText(t.key)+'"'+(target.key===t.key?' selected':'')+'>'+escapeText(t.name)+'</option>').join('')
  const svg=renderPoster(project,target.key)
  const previewHeader='<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><label>Poster <select id="poster-target">'+options+'</select></label><label><input type="checkbox" id="poster-phone"'+checked(state.phone)+'> Phone width</label>'+(mode==='full'?'<button id="download-poster">Download '+state.format.toUpperCase()+'</button>':'')+'</div>'
  const previewCanvas='<div id="poster-preview" style="margin:18px auto;width:'+ (state.phone?'375px':'min(100%, 560px)')+';max-width:100%;line-height:0;box-shadow:0 4px 16px #183e3422">'+svg+'</div>'
  if (mode==='preview') {
    host.innerHTML=previewHeader+previewCanvas
    const get=<T extends HTMLElement>(selector:string)=>host.querySelector<T>(selector)!
    get<HTMLSelectElement>('#poster-target').onchange=e=>{state.active=(e.currentTarget as HTMLSelectElement).value;onChange()}
    get<HTMLInputElement>('#poster-phone').onchange=e=>{state.phone=(e.currentTarget as HTMLInputElement).checked;onChange()}
    return
  }
  const checks=targets.map(t=>'<label><input type="checkbox" data-poster-key="'+escapeText(t.key)+'"'+checked(state.selected.includes(t.key))+'>'+escapeText(t.name)+'</label>').join(' ')
  const days=targets.filter(t=>t.key.startsWith('day:')).map(t=>'<label><input type="checkbox" data-group-day="'+escapeText(t.days[0].id)+'">'+escapeText(t.name)+'</label>').join(' ')
  const pins=eligible.map(p=>{
    const selected=state.placeText?.[target.key]?.[p.id] ?? 'name'
    const modes={name:'Name',category:'Category',both:'Name and category',pin:'Pin only'}
    const options=Object.entries(modes).map(([key,name])=>'<option value="'+key+'"'+(selected===key?' selected':'')+'>'+name+'</option>').join('')
    return '<div><label><input type="checkbox" data-visibility="'+escapeText(p.id)+'"'+checked(state.placeVisibility?.[target.key]?.[p.id] ?? p.visible)+'>'+escapeText(p.name)+'</label> <select aria-label="Printed label for '+escapeText(p.name)+'" data-place-text="'+escapeText(p.id)+'">'+options+'</select></div>'
  }).join('')
  const openDetails=new Set(Array.from(host.querySelectorAll('details[open]')).map(d=>d.id))
  const open=(id:string)=>openDetails.has(id)?' open':''
  host.innerHTML=previewHeader+previewCanvas+
    '<details id="poster-style"'+open('poster-style')+'><summary>Poster style</summary><fieldset><label>Trip title <input type="text" id="poster-title" maxlength="100" value="'+escapeText(state.title)+'"></label> <label>Credit <input type="text" id="poster-credit" maxlength="140" value="'+escapeText(state.credit)+'"></label> <label>Accent <input id="poster-accent" type="color" value="'+state.accent+'"></label><p>'+
    (['showDistance','showPeak','showProfile'] as const).map((prop,i)=>'<label><input type="checkbox" data-stat="'+prop+'"'+checked(state[prop])+'>'+['Distance','Highest point','Elevation profile'][i]+'</label>').join(' ')+'</p></fieldset></details>'+
    (eligible.length?'<details id="poster-labels"'+open('poster-labels')+'><summary>Map labels</summary><fieldset><legend>Places on this poster</legend>'+pins+'<p>Drag a map label to move it. Keyboard users can focus a label and use the arrow keys.</p><button id="reset-labels">Reset label positions</button></fieldset></details>':'')+
    '<details id="poster-collection"'+open('poster-collection')+'><summary>Poster collection</summary><fieldset><legend>Group days on one poster</legend>'+days+'<p><label>Group name <input id="group-name" type="text" maxlength="70"></label> <button id="add-group">Create group</button></p></fieldset><fieldset><legend>Include in ZIP</legend>'+checks+'</fieldset></details>'+
    '<div style="display:flex;gap:12px;align-items:center"><label>File format <select id="poster-format"><option value="jpg">JPG</option><option value="png">PNG</option></select></label><button id="download-zip">Download ZIP</button></div><p id="output-status" role="status"></p>'
  const get=<T extends HTMLElement>(selector:string)=>host.querySelector<T>(selector)!
  const message=get('#output-status')
  const change=<T extends HTMLInputElement|HTMLSelectElement>(selector:string,fn:(el:T)=>void)=>{
    const el=get<T>(selector)
    el.onchange=()=>{fn(el);onChange()}
  }
  change<HTMLSelectElement>('#poster-target',el=>state.active=el.value)
  change<HTMLInputElement>('#poster-phone',el=>state.phone=el.checked)
  change('#poster-title',el=>state.title=el.value)
  change('#poster-credit',el=>state.credit=el.value)
  change('#poster-accent',el=>state.accent=el.value)
  get<HTMLSelectElement>('#poster-format').value=state.format
  change('#poster-format',el=>state.format=el.value==='png'?'png':'jpg')
  for(const el of host.querySelectorAll<HTMLInputElement>('[data-stat]')) {
    const prop=el.dataset.stat as 'showDistance'|'showPeak'|'showProfile'
    el.onchange=()=>{state[prop]=el.checked;onChange()}
  }
  for(const el of host.querySelectorAll<HTMLInputElement>('[data-visibility]')) {
    el.onchange=()=>{
      const visibility=state.placeVisibility ||= {}
      const places=visibility[target.key] ||= {}
      places[el.dataset.visibility!]=el.checked
      onChange()
    }
  }
  for(const el of host.querySelectorAll<HTMLSelectElement>('[data-place-text]')) {
    el.onchange=()=>{
      const modes=state.placeText ||= {}
      const places=modes[target.key] ||= {}
      places[el.dataset.placeText!]=el.value as 'name'|'category'|'both'|'pin'
      onChange()
    }
  }
  const reset=host.querySelector<HTMLButtonElement>('#reset-labels')
  if(reset) reset.onclick=()=>{delete state.labels[target.key];onChange()}
  get('#add-group').onclick=()=>{
    const ids=Array.from(host.querySelectorAll<HTMLInputElement>('[data-group-day]:checked'),el=>el.dataset.groupDay!)
    if(ids.length<2){message.textContent='Choose at least two days for a group.';return}
    const id=crypto.randomUUID()
    const name=get<HTMLInputElement>('#group-name').value.trim() || ids.map(id=>targets.find(t=>t.key==='day:'+id)!.name).join(' + ')
    state.groups.push({id,name,dayIds:ids})
    state.active='group:'+id
    state.selected.push(state.active)
    onChange()
  }
  for(const el of host.querySelectorAll<HTMLInputElement>('[data-poster-key]')) {
    el.onchange=()=>{
      const key=el.dataset.posterKey!
      state.selected=state.selected.filter(k=>k!==key)
      if(el.checked) state.selected.push(key)
      onChange()
    }
  }
  wireLabelEditing(host.querySelector<SVGSVGElement>('#poster-preview svg')!,target.key,state,onChange)
  const files=posterFiles(project,targets)
  const individual=get<HTMLButtonElement>('#download-poster'), archive=get<HTMLButtonElement>('#download-zip')
  const selected=files.filter(f=>state.selected.includes(f.target.key))
  archive.disabled=!selected.length
  const run=async(collection:boolean)=>{
    individual.disabled=archive.disabled=true
    message.textContent='Preparing images…'
    try {
      const format=state.format, archiveName=slug(state.title)+'-posters.zip'
      if(collection){
        const plan=selected.map(file=>({name:file.name,svg:renderPoster(project,file.target.key)}))
        const entries=[]
        for(const file of plan) {
          const blob=await rasterize(file.svg,format)
          entries.push({name:file.name,bytes:new Uint8Array(await blob.arrayBuffer())})
        }
        download(zip(entries),archiveName)
      }else{
        download(await rasterize(svg,format),files.find(f=>f.target.key===target.key)!.name)
      }
      message.textContent='Download ready.'
    }catch(e){message.textContent=e instanceof Error?e.message:'Download failed.'}
    finally{individual.disabled=false;archive.disabled=!selected.length}
  }
  individual.onclick=()=>void run(false)
  archive.onclick=()=>void run(true)
}

function wireLabelEditing(svg:SVGSVGElement,key:string,state:OutputState,onChange:()=>void) {
  const save=(id:string,x:number,y:number)=>{
    const labels=state.labels[key] ||= {}
    labels[id]={x,y}
    onChange()
  }
  for(const label of svg.querySelectorAll<SVGTextElement>('[data-label]')){
    const id=label.dataset.label!
    label.style.cursor='move';label.style.touchAction='none'
    label.setAttribute('tabindex','0')
    label.onkeydown=e=>{
      const delta:Record<string,[number,number]>={ArrowLeft:[-7,0],ArrowRight:[7,0],ArrowUp:[0,-7],ArrowDown:[0,7]}
      if(!delta[e.key]) return
      e.preventDefault()
      save(id,Number(label.getAttribute('x'))+delta[e.key][0],Number(label.getAttribute('y'))+delta[e.key][1])
      document.querySelector<SVGTextElement>('[data-label="'+CSS.escape(id)+'"]')?.focus()
    }
    label.onpointerdown=e=>{
      const matrix=svg.getScreenCTM()
      if(!matrix) return
      const local=(event:PointerEvent)=>new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse())
      const origin=local(e),x=Number(label.getAttribute('x')),y=Number(label.getAttribute('y'))
      label.setPointerCapture(e.pointerId)
      label.onpointermove=move=>{
        const p=local(move)
        label.setAttribute('x',fCoord(x+p.x-origin.x));label.setAttribute('y',fCoord(y+p.y-origin.y))
      }
      label.onpointerup=up=>{label.onpointermove=null;label.onpointerup=null;const p=local(up);save(id,x+p.x-origin.x,y+p.y-origin.y)}
      label.onpointercancel=()=>{label.onpointermove=null;label.onpointerup=null;label.setAttribute('x',String(x));label.setAttribute('y',String(y))}
    }
  }
}
const fCoord=(n:number)=>n.toFixed(1)
