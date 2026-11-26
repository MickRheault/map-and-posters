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

test('guided wizard defaults to Step 1, supports GPX import/reorder/overlap exclusion, step focus, and mode switching', async()=>{
  const app=await open()
  try {
    const wizardBtn=app.doc.querySelector<HTMLButtonElement>('[data-mode="wizard"]')!
    const fullBtn=app.doc.querySelector<HTMLButtonElement>('[data-mode="full"]')!
    expect(wizardBtn.getAttribute('aria-pressed')).toBe('true')
    expect(fullBtn.getAttribute('aria-pressed')).toBe('false')
    expect(app.doc.querySelector('[data-step="1"]')?.getAttribute('aria-current')).toBe('step')
    expect(app.doc.querySelector('#wizard-heading')?.textContent).toContain('Import GPX')
    expect(app.doc.querySelector<HTMLElement>('.tabs')?.hidden).toBe(true)

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
    expect(app.doc.querySelector('#output svg')?.textContent).toContain('4.4 km')
    expect(app.doc.querySelector('#download-poster')).toBeNull()
    expect(app.doc.querySelector('#download-zip')).toBeNull()

    app.button('Next: Split days')
    expect(app.doc.querySelector('[data-step="2"]')?.getAttribute('aria-current')).toBe('step')
    expect(app.doc.activeElement).toBe(app.doc.querySelector('#wizard-heading'))

    app.button('Back')
    expect(app.doc.querySelector('[data-step="1"]')?.getAttribute('aria-current')).toBe('step')
    expect(rows()[0].textContent).toContain('east.gpx')

    app.button('Full editor')
    expect(fullBtn.getAttribute('aria-pressed')).toBe('true')
    expect(app.doc.querySelector<HTMLElement>('.tabs')?.hidden).toBe(false)
    expect(app.doc.querySelector('#download-poster')).not.toBeNull()
    expect(rows()[0].textContent).toContain('east.gpx')

    app.button('Guided wizard')
    expect(wizardBtn.getAttribute('aria-pressed')).toBe('true')
    expect(app.doc.querySelector('#download-poster')).toBeNull()
  } finally { app.dom.window.close() }
})

test('Step 1 can start a photo-only rest day before any GPX is imported', async()=>{
  const app=await open()
  try {
    app.button('Start with a rest day')
    expect(app.doc.querySelector('#itinerary')?.textContent).toContain('Rest day added')
    expect(app.doc.querySelector('#output svg')?.textContent).toContain('Day 1')
  } finally { app.dom.window.close() }
})
