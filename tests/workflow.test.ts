import {beforeAll, expect, test} from 'bun:test'
import {JSDOM, type DOMWindow} from 'jsdom'
import sharp from 'sharp'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

let html: string
beforeAll(async()=>{
  const bundle=await Bun.build({entrypoints:['src/app.ts'],format:'iife',target:'browser'})
  if (!bundle.success) throw new AggregateError(bundle.logs)
  const template=await Bun.file('src/editor.html').text(), script=await bundle.outputs[0].text()
  html=template.replace('/* APP */',()=>script)
})

// JSDOM provides XML parsing, DOM, and UI events. Supply its missing storage,
// graphics, and download primitives. libvips rasterizes the actual exported SVG.
function editor(store=new Map<string,unknown>()) {
  const urls=new Map<string,Blob>(),downloads=new Map<string,Blob>()
  function install(w: DOMWindow) {
    w.confirm=()=>true
    w.Blob=Blob
    w.TextEncoder=TextEncoder
    w.TextDecoder=TextDecoder
    w.URL.createObjectURL=(blob:Blob)=>{
      const url='blob:https://trip.test/'+crypto.randomUUID()
      urls.set(url,blob)
      return url
    }
    w.URL.revokeObjectURL=(url:string)=>{urls.delete(url)}
    w.HTMLAnchorElement.prototype.click=function() {
      const data=urls.get(this.href)
      if (!data) throw new Error('Missing bytes for '+this.download)
      downloads.set(this.download,data)
    }
    w.FileReader=class {
      result=''
      onload?:()=>void
      async readAsDataURL(blob:Blob) {
        this.result='data:'+blob.type+';base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64')
        this.onload?.()
      }
    }
    class RasterImage {
      src=''
      naturalWidth=0
      naturalHeight=0
      bytes!:Buffer
      jpeg!:Buffer
      async decode(){
        const source=urls.get(this.src)
        if(!source) throw new Error('Image source unavailable')
        this.bytes=Buffer.from(await source.arrayBuffer())
        const meta=await sharp(this.bytes).metadata()
        this.naturalWidth=meta.width; this.naturalHeight=meta.height
        if(meta.format!=='svg') this.jpeg=await sharp(this.bytes).resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).flatten({background:'#fff'}).jpeg().toBuffer()
      }
    }
    w.Image=RasterImage
    const drawn=new WeakMap<HTMLCanvasElement,RasterImage>()
    w.HTMLCanvasElement.prototype.getContext=function(){
      return {fillRect(){},drawImage:(img:RasterImage)=>drawn.set(this,img)}
    }
    w.HTMLCanvasElement.prototype.toDataURL=function(){
      return 'data:image/jpeg;base64,'+drawn.get(this)!.jpeg.toString('base64')
    }
    w.HTMLCanvasElement.prototype.toBlob=function(done:(blob:Blob)=>void,type:string) {
      const render=sharp(drawn.get(this)!.bytes).resize(this.width,this.height)
      void (type==='image/png'?render.png():render.jpeg()).toBuffer().then(bytes=>done(new Blob([bytes],{type})))
    }
    w.indexedDB={
      open(){
        const result={
          createObjectStore(){},
          transaction(){
            const tx={
              oncomplete:undefined as (()=>void)|undefined,
              objectStore:()=>({
                get(key:string){
                  const req={result:structuredClone(store.get(key)),onsuccess:undefined as (()=>void)|undefined}
                  queueMicrotask(()=>req.onsuccess?.())
                  return req
                },
                put(value:unknown,key:string){
                  store.set(key,structuredClone(value))
                  queueMicrotask(()=>tx.oncomplete?.())
                }
              })
            }
            return tx
          }
        }
        const req={result,onupgradeneeded:undefined as (()=>void)|undefined,onsuccess:undefined as (()=>void)|undefined}
        queueMicrotask(()=>{if(!store.size) req.onupgradeneeded?.();req.onsuccess?.()})
        return req
      }
    }
  }
  const dom=new JSDOM(html,{url:'https://trip.test',runScripts:'dangerously',beforeParse:install})
  const doc=dom.window.document
  function button(text:string) {
    const b=Array.from(doc.querySelectorAll('button')).find(b=>b.textContent===text)
    if(!b) throw new Error('Missing button '+text)
    expect(b.disabled).toBe(false)
    b.click()
  }
  function field(name:string,scope:ParentNode=doc) {
    const label=Array.from(scope.querySelectorAll('label')).find(el=>el.textContent?.trim().startsWith(name))
    const input=label?.querySelector<HTMLInputElement|HTMLSelectElement>('input,select')
    if(!input) throw new Error('Missing field '+name)
    return input
  }
  function change(el:HTMLInputElement|HTMLSelectElement,value:string) {
    el.value=value;el.dispatchEvent(new dom.window.Event('change',{bubbles:true}))
  }
  async function upload(selector:string,files:File[]) {
    const input=doc.querySelector<HTMLInputElement>(selector)!
    Object.defineProperty(input,'files',{configurable:true,value:files})
    await input.onchange!.call(input,new dom.window.Event('change'))
  }
  return {doc,dom,button,field,change,upload,downloads,store}
}

async function until(check:()=>boolean,reason:string) {
  const end=Date.now()+10000
  while(!check() && Date.now()<end) await Bun.sleep(10)
  if(!check()) throw new Error(reason)
}

async function open(store?:Map<string,unknown>) {
  const app=editor(store)
  await until(()=>!app.doc.querySelector<HTMLInputElement>('#file')!.disabled,'Editor did not open')
  return app
}

function gpx(name:string,coords:[number,number,number?][]) {
  const points=coords.map(([lat,lon,ele])=>'<trkpt lat="'+lat+'" lon="'+lon+'">'+(ele===undefined?'':'<ele>'+ele+'</ele>')+'</trkpt>').join('')
  return new File(['<gpx><trk><trkseg>'+points+'</trkseg></trk></gpx>'],name,{type:'application/gpx+xml'})
}

test('multi-file trip excludes a duplicate, reorders recordings and groups two days without adding a gap', async()=>{
  const app=await open()
  try {
    app.button('Full editor')
    const a=gpx('west.gpx',[[0,0],[0,0.01],[0,0.02]])
    const b=gpx('east.gpx',[[0,5],[0,5.01],[0,5.02]])
    const duplicate=new File([a],'copy.gpx',{type:a.type})
    await app.upload('#file',[a,b,duplicate])
    expect(app.doc.querySelector('#message')?.textContent).toContain('Imported 3 GPX files')
    const rows=()=>Array.from(app.doc.querySelectorAll<HTMLElement>('.recording-row'))
    expect(rows()[2].textContent).toContain('Possible overlap')
    rows()[2].querySelector('input')!.click()
    rows()[1].querySelector('button')!.click()
    expect(rows()[0].textContent).toContain('east.gpx')
    const selector=app.field('Edit day') as HTMLSelectElement
    app.change(selector,selector.options[0].value)
    app.button('Group with next day')
    app.button('Download backup')
    const saved=JSON.parse(await app.downloads.get('map-and-posters-backup.json')!.text()).project
    expect(saved.recordings.map((r:{name:string,included:boolean})=>[r.name,r.included])).toEqual([['east.gpx',true],['west.gpx',true],['copy.gpx',false]])
    expect(saved.sources).toHaveLength(3)
    expect(saved.days[0].ranges.map((r:{recordingId:string})=>r.recordingId)).toEqual(saved.recordings.slice(0,2).map((r:{id:string})=>r.id))
    const svg=app.doc.querySelector('#output svg')!
    expect(svg.textContent).toContain('4.4 km')
    expect(svg.textContent).not.toMatch(/elevation|highest/i)
  } finally { app.dom.window.close() }
})

test('split an out-and-back, include a rest day with a photo, reload, restore, and download posters',async()=>{
  const app=await open(),windows=[app.dom.window]
  const tmp=await mkdtemp(join(tmpdir(),'trip-editor-'))
  try {
    app.button('Full editor')
    const route=gpx('Loop.gpx',[[18,98,300],[18,98.01,310],[18.02,98.01,1800],[18,98.01,310],[18,98,300],[18,98.03,320],[18,98.05,340]])
    const waypoints=new File(['<gpx><wpt lat="18" lon="98.01"><name>Farm homestay</name></wpt><wpt lat="18.04" lon="98.04"><name>Off-route meadow</name></wpt></gpx>'],'places.gpx',{type:route.type})
    await app.upload('#file',[route,waypoints])
    app.button('Places & photos')
    const farmPanel=Array.from(app.doc.querySelectorAll('details')).find(el=>el.querySelector('summary')?.textContent==='Farm homestay')!
    farmPanel.open=true
    farmPanel.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    app.button('Itinerary')
    const boundary=app.field('Boundary point')
    boundary.value='3';boundary.dispatchEvent(new app.dom.window.Event('input'))
    app.button('Create next day')
    const days=app.field('Edit day') as HTMLSelectElement
    expect(days.options).toHaveLength(2)
    app.change(days,days.options[1].value)
    app.button('Rest day after')
    app.change(app.field('Day name'),'Pai')
    app.button('Places & photos')
    const farm=Array.from(app.doc.querySelectorAll('details')).find(el=>el.querySelector('summary')?.textContent==='Farm homestay')!
    farm.open=true
    farm.dispatchEvent(new app.dom.window.Event('toggle'))
    ;(app.field('Overnight stay',farm) as HTMLInputElement).click()
    Array.from(farm.querySelectorAll('button')).find(b=>b.textContent==='Add visit')!.click()
    const target=app.field('Add photos to') as HTMLSelectElement
    app.change(target,target.options[3].value)
    const original=await sharp({create:{width:4400,height:2800,channels:3,background:'#a92725'}}).jpeg().toBuffer()
    await app.upload('#assets input[type=file]',[new File([original],'rest-hero.jpg',{type:'image/jpeg'})])
    app.button('Download backup')
    const backupBlob=app.downloads.get('map-and-posters-backup.json')!
    const backed=JSON.parse(await backupBlob.text()).project
    expect(backed.photos[0].original.split(',')[1]).toEqual(original.toString('base64'))
    expect(backed.photos[0].width).toBe(2048)
    expect(backed.photos[0].dayId).toBe(backed.days[2].id)
    expect(backed.days[2].rest).toBe(true)
    expect(backed.visits[0]).toMatchObject({placeId:backed.places[0].id,dayId:backed.days[0].id,overnight:true,position:{point:3}})
    expect(backed.days[0].ranges[0].end).toBe(3)
    expect(backed.places.map((p:{visible:boolean})=>p.visible)).toEqual([true,false])
    await until(()=>app.doc.querySelector('#storage-status')?.textContent==='Saved on this device','Autosave failed')
    const reloaded=await open(app.store);windows.push(reloaded.dom.window)
    reloaded.button('Full editor')
    reloaded.button('Download backup')
    expect(await reloaded.downloads.get('map-and-posters-backup.json')!.text()).toEqual(await backupBlob.text())
    const fresh=await open();windows.push(fresh.dom.window)
    fresh.button('Full editor')
    await fresh.upload('#restore',[new File([backupBlob],'trip.json',{type:'application/json'})])
    expect(fresh.doc.querySelector('#message')?.textContent).toContain('Restored')
    expect(fresh.doc.querySelector('#output svg')?.outerHTML).toBe(reloaded.doc.querySelector('#output svg')?.outerHTML)
    fresh.button('Download backup')
    expect(await fresh.downloads.get('map-and-posters-backup.json')!.text()).toEqual(await backupBlob.text())
    await checkDownloads(fresh,tmp)
  } finally {
    windows.forEach(win=>win.close())
    await rm(tmp,{recursive:true,force:true})
  }
},30000)

async function verifyZip(blob:Blob,dir:string,expectedNames:string[],downloads:Map<string,Blob>) {
  const pathname=join(dir,'posters.zip')
  await writeFile(pathname,Buffer.from(await blob.arrayBuffer()))
  const listing=Bun.spawnSync(['unzip','-Z1',pathname])
  expect(listing.exitCode).toBe(0)
  expect(listing.stdout.toString().trim().split('\n').sort()).toEqual([...expectedNames].sort())
  expect(Bun.spawnSync(['unzip','-tq',pathname]).exitCode).toBe(0)
  for(const name of expectedNames) {
    const member=Bun.spawnSync(['unzip','-p',pathname,name])
    expect(member.exitCode).toBe(0)
    const metadata=await sharp(member.stdout).metadata()
    expect(metadata.format).toBe(name.endsWith('.png')?'png':'jpeg')
    expect(metadata.width).toBe(1080)
    expect(metadata.height).toBeGreaterThan(0)
    expect(member.stdout).toEqual(Buffer.from(await downloads.get(name)!.arrayBuffer()))
  }
}

async function verifyRestPhoto(blob:Blob) {
  const pixels=sharp(Buffer.from(await blob.arrayBuffer()))
  expect((await pixels.metadata()).format).toBe('jpeg')
  // A red source photo must occupy actual pixels in the exported poster.
  const {data,info}=await pixels.resize({width:100}).removeAlpha().raw().toBuffer({resolveWithObject:true})
  let red=0
  for(let i=0;i<data.length;i+=info.channels) {
    if(data[i]>120 && data[i]>2*data[i+1] && data[i]>2*data[i+2]) red++
  }
  expect(red/(info.width*info.height)).toBeGreaterThan(0.05)
}

async function checkDownloads(app:ReturnType<typeof editor>,dir:string) {
  const target=()=>app.doc.querySelector<HTMLSelectElement>('#poster-target')!
  const format=()=>app.doc.querySelector<HTMLSelectElement>('#poster-format')!
  const dayKeys=Array.from(target().options).map(o=>o.value).filter(value=>value.startsWith('day:'))
  expect(dayKeys).toHaveLength(3)
  expect(format().value).toBe('jpg')
  const click=(id:string)=>app.doc.querySelector<HTMLButtonElement>(id)!.click()
  async function individual(key:string,extension:string) {
    app.change(target(),key)
    const before=new Set(app.downloads.keys())
    click('#download-poster')
    let name:string|undefined
    await until(()=>{
      name=Array.from(app.downloads.keys()).find(name=>!before.has(name) && name.endsWith('.'+extension))
      return Boolean(name)
    },'Missing exported '+key+' '+extension+'; '+app.doc.querySelector('#output')?.textContent?.slice(-260))
    return name!
  }
  const rest=await individual(dayKeys[2],'jpg')
  await verifyRestPhoto(app.downloads.get(rest)!)
  app.change(format(),'png')
  const expectedNames=[await individual('trip','png'),await individual(dayKeys[2],'png')]
  const wanted=new Set(['trip',dayKeys[2]])
  const selected=Array.from(app.doc.querySelectorAll<HTMLInputElement>('input[data-poster-key]')).map(e=>e.dataset.posterKey!)
  expect(selected).toContain(dayKeys[2])
  for(const key of selected) {
    const checkbox=Array.from(app.doc.querySelectorAll<HTMLInputElement>('input[data-poster-key]')).find(e=>e.dataset.posterKey===key)!
    if(checkbox.checked!==wanted.has(key)) checkbox.click()
  }
  click('#download-zip')
  // Export takes its snapshot before the user starts another edit.
  app.change(format(),'jpg')
  await until(()=>Array.from(app.downloads.keys()).some(name=>name.endsWith('.zip')),'ZIP was not downloaded')
  const zip=Array.from(app.downloads).find(([name])=>name.endsWith('.zip'))![1]
  await verifyZip(zip,dir,expectedNames,app.downloads)
}

test('centered wizard dialog opens on Step 1, handles GPX upload/reorder/overlap, rest-day start, and Full editor toggle', async()=>{
  const app=await open()
  try {
    const dialog=app.doc.querySelector<HTMLDialogElement>('#wizard-dialog')!
    expect(dialog).not.toBeNull()
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(dialog.querySelector('h1#wizard-heading')?.textContent).toBe('Add your GPX')
    expect(dialog.querySelector('[data-step="1"]')?.getAttribute('aria-current')).toBe('step')
    expect(dialog.querySelector<HTMLButtonElement>('#wizard-next')?.hidden).toBe(true)

    const a=gpx('west.gpx',[[0,0],[0,0.01],[0,0.02]])
    const b=gpx('east.gpx',[[0,5],[0,5.01],[0,5.02]])
    const duplicate=new File([a],'copy.gpx',{type:a.type})
    await app.upload('#wizard-gpx',[a,b,duplicate])
    expect(dialog.querySelector<HTMLButtonElement>('#wizard-next')?.hidden).toBe(false)

    const rows=()=>Array.from(dialog.querySelectorAll<HTMLElement>('.wiz-rec'))
    expect(rows()).toHaveLength(3)
    expect(rows()[2].textContent).toContain('Possible overlap')
    rows()[2].querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    rows()[1].querySelector<HTMLButtonElement>('button[aria-label*="earlier"]')!.click()
    expect(rows()[0].textContent).toContain('east.gpx')
    expect(dialog.textContent).toContain('4.4 km')

    app.button('Continue')
    expect(dialog.querySelector('[data-step="2"]')?.getAttribute('aria-current')).toBe('step')
    expect(app.doc.activeElement).toBe(dialog.querySelector('#wizard-heading'))

    app.button('Back')
    expect(dialog.querySelector('[data-step="1"]')?.getAttribute('aria-current')).toBe('step')
    expect(rows()[0].textContent).toContain('east.gpx')

    // Exit to Full editor and reopen Guided wizard without losing edits
    app.button('Full editor')
    expect(dialog.hasAttribute('open')).toBe(false)
    expect(app.doc.querySelector('#output svg')?.textContent).toContain('4.4 km')
    app.button('Guided wizard')
    expect(dialog.hasAttribute('open')).toBe(true)
  } finally { app.dom.window.close() }
})

test('centered wizard Step 1 can start with a photo-only rest day', async()=>{
  const app=await open()
  try {
    const dialog=app.doc.querySelector<HTMLDialogElement>('#wizard-dialog')!
    app.button('Start with a rest day')
    expect(dialog.querySelector('[data-step="2"]')?.getAttribute('aria-current')).toBe('step')
    expect(dialog.textContent).toContain('Day 1')
  } finally { app.dom.window.close() }
})

test('centered wizard walks Steps 1 → 5: split repeated pass, rest day, stops + overnight, photos + crop + GPS pin, title, label drag, downloads, reload and backup restore', async()=>{
  const app=await open(),windows=[app.dom.window]
  const tmp=await mkdtemp(join(tmpdir(),'wizard-dialog-'))
  try {
    const dialog=()=>app.doc.querySelector<HTMLDialogElement>('#wizard-dialog')!

    // Step 1: Upload out-and-back GPX + waypoints
    const route=gpx('Loop.gpx',[[18,98,300],[18,98.01,310],[18.02,98.01,1800],[18,98.01,310],[18,98,300],[18,98.03,320],[18,98.05,340]])
    const waypoints=new File(['<gpx><wpt lat="18" lon="98.01"><name>Farm homestay</name></wpt></gpx>'],'places.gpx',{type:route.type})
    await app.upload('#wizard-gpx',[route,waypoints])
    app.button('Continue')

    // Step 2: Split on 2nd visit to (18, 98.01) via map click, then add named rest day
    expect(dialog().querySelector('#wizard-heading')?.textContent).toBe('Split into days')
    const map=dialog().querySelector<SVGSVGElement>('svg[aria-label="Choose a boundary on the recorded route"]')!
    Object.defineProperty(map,'getBoundingClientRect',{value:()=>({left:0,top:0,width:400,height:200})})
    const pts:{x:number,y:number}[]=[]
    for(const p of Array.from(map.querySelectorAll('path')).reverse()) {
      for(const m of p.getAttribute('d')!.matchAll(/([ML])([\d.-]+),([\d.-]+)/g)) {
        const pt={x:Number(m[2]),y:Number(m[3])},last=pts[pts.length-1]
        if(!last || Math.hypot(pt.x-last.x,pt.y-last.y)>0.1) pts.push(pt)
      }
    }
    const repeat=pts.find((pt,i)=>i>0 && pts.slice(i+1,-1).some(o=>Math.hypot(o.x-pt.x,o.y-pt.y)<0.5))!
    map.dispatchEvent(new app.dom.window.MouseEvent('click',{clientX:repeat.x,clientY:repeat.y}))
    const passes=dialog().querySelector<HTMLSelectElement>('select[aria-label="Matching visits"]')!
    expect(passes.options).toHaveLength(2)
    app.change(passes,passes.options[1].value)
    app.button('Split here')
    expect(dialog().querySelectorAll('.wiz-day-pill')).toHaveLength(2)
    app.button('+ Rest day')
    const dayNameInput=dialog().querySelector<HTMLInputElement>('input[aria-label="Day name"]')!
    app.change(dayNameInput,'Pai')
    app.button('Continue')

    // Step 3: Pick stops — toggle Farm homestay visible + one-click Overnight, plus add custom stop
    expect(dialog().querySelector('#wizard-heading')?.textContent).toBe('Pick stops')
    const stopRow=Array.from(dialog().querySelectorAll<HTMLElement>('.wiz-stop')).find(r=>r.textContent?.includes('Farm homestay'))!
    stopRow.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    const stopRowAfter=Array.from(dialog().querySelectorAll<HTMLElement>('.wiz-stop')).find(r=>r.textContent?.includes('Farm homestay'))!
    const overnightBtn=Array.from(stopRowAfter.querySelectorAll('button')).find(b=>b.textContent==='Overnight')!
    overnightBtn.click()
    expect(Array.from(dialog().querySelectorAll<HTMLElement>('.wiz-stop')).find(r=>r.textContent?.includes('Farm homestay'))!.querySelector('button[aria-pressed="true"]')).not.toBeNull()
    app.button('+ Add place')
    const placeName=dialog().querySelector<HTMLInputElement>('input[aria-label="Place name"]')!
    const placeLoc=dialog().querySelector<HTMLInputElement>('input[aria-label="Location"]')!
    placeName.value='Ridge camp';placeLoc.value='18.04, 98.04'
    app.button('Add')
    expect(dialog().textContent).toContain('Ridge camp')
    app.button('Continue')

    // Step 4: Add photos (one GPS-tagged + one rest-day hero with crop)
    expect(dialog().querySelector('#wizard-heading')?.textContent).toBe('Add photos')
    const target=dialog().querySelector<HTMLSelectElement>('#wizard-photo-day')!
    const paiOpt=Array.from(target.options).find(o=>o.textContent?.includes('Pai'))!
    app.change(target,paiOpt.value)
    const baseJpeg=await sharp({create:{width:1200,height:800,channels:3,background:'#a92725'}}).jpeg().toBuffer()
    const tiff=new Uint8Array(128),td=new DataView(tiff.buffer)
    td.setUint16(0,0x4949,true);td.setUint16(2,42,true);td.setUint32(4,8,true);td.setUint16(8,1,true)
    td.setUint16(10,0x8825,true);td.setUint16(12,4,true);td.setUint32(14,1,true);td.setUint32(18,26,true)
    td.setUint16(26,4,true)
    for(let e=0;e<4;e++){
      const at=28+12*e,ref=e%2===0
      td.setUint16(at,e+1,true);td.setUint16(at+2,ref?2:5,true);td.setUint32(at+4,ref?2:3,true)
      if(ref) tiff[at+8]=e===0?78:69
      else {const off=e===1?80:104;td.setUint32(at+8,off,true);[e===1?18:98,1,0].forEach((n,i)=>{td.setUint32(off+8*i,n,true);td.setUint32(off+8*i+4,1,true)})}
    }
    const app1=new Uint8Array(10+tiff.length)
    app1.set([0xff,0xe1,0,0,69,120,105,102,0,0]);app1.set(tiff,10)
    new DataView(app1.buffer).setUint16(2,tiff.length+8)
    const gpsPhoto=Buffer.concat([baseJpeg.subarray(0,2),app1,baseJpeg.subarray(2)])
    await app.upload('#wizard-photos',[new File([gpsPhoto],'rest-hero.jpg',{type:'image/jpeg'})])
    const card=dialog().querySelector<HTMLElement>('.wiz-photo')!
    const leadBtn=Array.from(card.querySelectorAll('button')).find(b=>b.textContent==='Lead')!
    leadBtn.click()
    expect(Array.from(dialog().querySelectorAll('.wiz-photo button')).find(b=>b.textContent==='Lead')?.getAttribute('aria-pressed')).toBe('true')
    Array.from(dialog().querySelectorAll('.wiz-photo button')).find(b=>b.textContent==='Crop')!.click()
    const zoom=dialog().querySelector<HTMLInputElement>('input[aria-label="Crop zoom"]')!
    zoom.value='1.6';zoom.dispatchEvent(new app.dom.window.Event('change',{bubbles:true}))
    Array.from(dialog().querySelectorAll('.wiz-photo button')).find(b=>b.textContent==='Pin GPS')!.click()
    expect(Array.from(dialog().querySelectorAll('.wiz-photo button')).find(b=>b.textContent==='Pin GPS')?.getAttribute('aria-pressed')).toBe('true')
    app.button('Continue')

    // Step 5: Title, phone toggle, preview, poster-specific label move (focus stays in dialog!), JPG/PNG/ZIP download & backup
    expect(dialog().querySelector('#wizard-heading')?.textContent).toBe('Ready to download')
    expect(dialog().querySelector<HTMLButtonElement>('#wizard-next')?.hidden).toBe(true)
    const titleInput=dialog().querySelector<HTMLInputElement>('#wizard-title')!
    app.change(titleInput,'North Loop')
    expect(dialog().querySelector('#wizard-preview svg')?.textContent).toContain('North Loop')

    const phoneToggle=dialog().querySelector<HTMLInputElement>('#wizard-phone')!
    phoneToggle.click()
    expect(dialog().querySelector('#wizard-preview')?.classList.contains('is-phone')).toBe(true)

    // Move label on Day 1 and verify focus stays inside #wizard-preview and Full trip stays independent
    const posterSel=dialog().querySelector<HTMLSelectElement>('#wizard-poster-target')!
    const day1Val=Array.from(posterSel.options).find(o=>o.value.startsWith('day:'))!.value
    app.change(posterSel,day1Val)
    const yBefore=Number(dialog().querySelector('#wizard-preview svg [data-label]')!.getAttribute('y'))
    dialog().querySelector<SVGTextElement>('#wizard-preview svg [data-label]')!.dispatchEvent(
      new app.dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})
    )
    expect(app.doc.activeElement).toBe(dialog().querySelector('#wizard-preview svg [data-label]'))
    const yAfter=Number(dialog().querySelector('#wizard-preview svg [data-label]')!.getAttribute('y'))
    expect(yAfter).toBeGreaterThan(yBefore)
    app.change(dialog().querySelector<HTMLSelectElement>('#wizard-poster-target')!,'trip')
    expect(Number(dialog().querySelector('#wizard-preview svg [data-label]')!.getAttribute('y'))).not.toBe(yAfter)

    // Download JPG of Rest Day, then individual PNG, then ZIP of all posters (decode members), then backup
    const restVal=Array.from(dialog().querySelector<HTMLSelectElement>('#wizard-poster-target')!.options).find(o=>o.textContent?.includes('Pai'))!.value
    app.change(dialog().querySelector<HTMLSelectElement>('#wizard-poster-target')!,restVal)
    dialog().querySelector<HTMLButtonElement>('#wizard-download')!.click()
    await until(()=>Array.from(app.downloads.keys()).some(n=>n.endsWith('.jpg')),'Wizard JPG download failed')
    const jpgName=Array.from(app.downloads.keys()).find(n=>n.endsWith('.jpg'))!
    await verifyRestPhoto(app.downloads.get(jpgName)!)

    app.change(dialog().querySelector<HTMLSelectElement>('#wizard-format')!,'png')
    dialog().querySelector<HTMLButtonElement>('#wizard-download')!.click()
    await until(()=>Array.from(app.downloads.keys()).some(n=>n.endsWith('.png')),'Wizard PNG download failed')
    const pngName=Array.from(app.downloads.keys()).find(n=>n.endsWith('.png'))!
    const pngMeta=await sharp(Buffer.from(await app.downloads.get(pngName)!.arrayBuffer())).metadata()
    expect(pngMeta.format).toBe('png')
    expect(pngMeta.width).toBe(1080)

    dialog().querySelector<HTMLButtonElement>('#wizard-download-zip')!.click()
    await until(()=>Array.from(app.downloads.keys()).some(n=>n.endsWith('.zip')),'Wizard ZIP download failed')
    const zipBlob=Array.from(app.downloads).find(([n])=>n.endsWith('.zip'))![1]
    const zipPath=join(tmp,'wizard.zip')
    await writeFile(zipPath,Buffer.from(await zipBlob.arrayBuffer()))
    expect(Bun.spawnSync(['unzip','-tq',zipPath]).exitCode).toBe(0)
    const zipNames=Bun.spawnSync(['unzip','-Z1',zipPath]).stdout.toString().trim().split('\n')
    expect(zipNames).toHaveLength(4)
    for(const name of zipNames) {
      const extracted=Bun.spawnSync(['unzip','-p',zipPath,name])
      expect(extracted.exitCode).toBe(0)
      const m=await sharp(extracted.stdout).metadata()
      expect(m.format).toBe('png')
      expect(m.width).toBe(1080)
    }

    dialog().querySelector<HTMLButtonElement>('#wizard-backup')!.click()
    const backupBlob=app.downloads.get('map-and-posters-backup.json')!
    await until(()=>app.doc.querySelector('#storage-status')?.textContent==='Saved on this device','Autosave failed')

    // Reload from IndexedDB and restore into a fresh session via Step 1 Restore backup
    const reloaded=await open(app.store);windows.push(reloaded.dom.window)
    reloaded.doc.querySelector<HTMLButtonElement>('[data-step="5"]')!.click()
    expect(reloaded.doc.querySelector('#wizard-preview svg')?.textContent).toContain('North Loop')

    const fresh=await open();windows.push(fresh.dom.window)
    await fresh.upload('#wizard-restore',[new File([backupBlob],'trip.json',{type:'application/json'})])
    fresh.doc.querySelector<HTMLButtonElement>('[data-step="5"]')!.click()
    expect(fresh.doc.querySelector('#wizard-preview svg')?.outerHTML).toBe(reloaded.doc.querySelector('#wizard-preview svg')?.outerHTML)
  } finally {
    await Bun.sleep(0)
    windows.forEach(w=>w.close())
    await rm(tmp,{recursive:true,force:true})
  }
},30000)

test('deleting any day (rest or riding) cleans up project state and New trip resets IndexedDB from scratch', async()=>{
  const app=await open(),windows=[app.dom.window]
  try {
    const dialog=()=>app.doc.querySelector<HTMLDialogElement>('#wizard-dialog')!
    const route=gpx('Loop.gpx',[[18,98,300],[18,98.01,310],[18.02,98.01,1800],[18,98.02,320]])
    const waypoints=new File(['<gpx><wpt lat="18" lon="98.01"><name>Camp</name></wpt></gpx>'],'places.gpx',{type:route.type})
    await app.upload('#wizard-gpx',[route,waypoints])
    app.button('Continue')

    // Split into Day 1 + Day 2 and add Day 3 rest day
    app.button('Split here')
    app.button('+ Rest day')
    expect(dialog().querySelectorAll('.wiz-day-pill')).toHaveLength(3)

    // Assign a photo to the rest day (Day 3) and overnight visit on Day 1
    app.button('Continue')
    const stop=dialog().querySelector<HTMLElement>('.wiz-stop')!
    stop.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    Array.from(dialog().querySelectorAll('.wiz-stop button')).find(b=>b.textContent==='Overnight')!.click()
    app.button('Continue')
    const target=dialog().querySelector<HTMLSelectElement>('#wizard-photo-day')!
    app.change(target,target.options[3].value)
    const jpg=await sharp({create:{width:600,height:400,channels:3,background:'#206040'}}).jpeg().toBuffer()
    await app.upload('#wizard-photos',[new File([jpg],'rest.jpg',{type:'image/jpeg'})])

    // Go back to Step 2 and delete BOTH the rest day AND a riding day inside the wizard dialog
    const wBtn=(text:string)=>Array.from(dialog().querySelectorAll('button')).find(b=>b.textContent===text)!.click()
    dialog().querySelector<HTMLButtonElement>('[data-step="2"]')!.click()
    const pills=()=>Array.from(dialog().querySelectorAll<HTMLButtonElement>('.wiz-day-pill'))
    pills()[2].click()
    wBtn('Delete day')
    expect(pills()).toHaveLength(2)

    // Delete riding Day 1 as well
    pills()[0].click()
    wBtn('Delete day')
    expect(pills()).toHaveLength(1)

    // Verify backup round-trip stays valid (visits cleaned, photo reassigned to Full trip)
    dialog().querySelector<HTMLButtonElement>('[data-step="5"]')!.click()
    dialog().querySelector<HTMLButtonElement>('#wizard-backup')!.click()
    const backupBlob=app.downloads.get('map-and-posters-backup.json')!
    const parsed=JSON.parse(await backupBlob.text()).project
    expect(parsed.days).toHaveLength(1)
    expect(parsed.visits).toHaveLength(0)
    expect(parsed.photos).toHaveLength(1)
    expect(parsed.photos[0].dayId).toBe('')

    // Delete the last remaining day in Full editor too (photo stays assigned to Full trip until New trip)
    wBtn('Full editor')
    app.button('Delete day')
    expect(app.doc.querySelector('#itinerary')?.textContent).toContain('Add a rest day')

    // Start fresh with New trip after re-importing a route
    await app.upload('#file',[route])
    expect(app.doc.querySelector('#output svg')).not.toBeNull()
    app.button('Guided wizard')
    dialog().querySelector<HTMLButtonElement>('[data-step="1"]')!.click()
    wBtn('New trip')
    expect(dialog().querySelector('#wizard-heading')?.textContent).toBe('Add your GPX')
    expect(dialog().querySelectorAll('.wiz-rec')).toHaveLength(0)
    expect(dialog().querySelector<HTMLButtonElement>('#wizard-next')?.hidden).toBe(true)
    expect(app.doc.querySelector('#output')?.innerHTML).toBe('')
    await until(()=>app.doc.querySelector('#storage-status')?.textContent==='Saved on this device','New trip autosave failed')

    // Reload from IndexedDB and verify it opens completely blank!
    const reloaded=await open(app.store);windows.push(reloaded.dom.window)
    expect(reloaded.doc.querySelectorAll('#wizard-dialog .wiz-rec')).toHaveLength(0)
    expect(reloaded.doc.querySelector('#output')?.innerHTML).toBe('')
  } finally {
    await Bun.sleep(0)
    windows.forEach(w=>w.close())
  }
})
