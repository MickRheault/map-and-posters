import {expect,test} from 'bun:test'
import {newProject} from '../src/project'
import {availablePosters,renderPoster} from '../src/poster'
import {mountOutput,posterFiles} from '../src/output'
import {importRecording,insertRestDay} from '../src/itinerary'
import type {Photo} from '../src/assets'

function trip() {
  const p=newProject()
  const record=(name:string,elevations:number[])=>{
    const pts=elevations.map((e,i)=>'<trkpt lat="18" lon="'+(98+i/100)+'"><ele>'+e+'</ele></trkpt>').join('')
    importRecording(p,'<gpx><trk><trkseg>'+pts+'</trkseg></trk></gpx>',name)
  }
  record('first',[100,500,600])
  record('second',[100,500,2000])
  return p
}
function xml(svg:string){return new DOMParser().parseFromString(svg,'image/svg+xml')}

test('trip and daily routes use the same elevation shading; earlier passes draw last',()=>{
  const p=trip()
  const [first,second]=p.days
  const full=xml(renderPoster(p)),daily=xml(renderPoster(p,'day:'+first.id))
  expect(Array.from(full.querySelectorAll('[data-route]'),g=>g.getAttribute('data-route'))).toEqual([second.id,first.id])
  const getStrokes=(svg:Document)=>Array.from(svg.querySelectorAll('[data-route="'+first.id+'"] path'),el=>el.getAttribute('stroke'))
  expect(getStrokes(full)).toEqual(getStrokes(daily))
  expect(daily.querySelectorAll('[data-route]').length).toBe(1)
})

test('rest, photo assignments, grouped visits, manual labels and visibility are poster-specific',()=>{
  const p=trip(), first=p.days[0]
  const rest=insertRestDay(p,1,'Pai')
  const asset=(dayId:string,name:string):Photo=>({
    id:name,dayId,name,src:'data:image/jpeg;base64,'+name,original:'data:image/jpeg;base64,'+name,
    width:200,height:150,zoom:1,cropX:.5,cropY:.5,hero:true
  })
  p.photos.push(asset('','overview'),asset(rest.id,'restPhoto'))
  p.places.push({id:'farm',name:'Salawin Fruit Jungle Farmstay',lat:18,lon:98,visible:true,category:'stay'})
  p.visits.push({id:'stay',placeId:'farm',dayId:first.id,overnight:true})
  const dayKey='day:'+first.id,restKey='day:'+rest.id
  p.output.labels[dayKey]={farm:{x:70,y:430}}
  const group={id:'both',name:'Ride & rest',dayIds:[first.id,rest.id]}
  p.output.groups.push(group)
  const daily=xml(renderPoster(p,dayKey)),full=xml(renderPoster(p)),off=xml(renderPoster(p,restKey))
  expect(daily.querySelector('[data-label="farm"]')?.getAttribute('x')).toBe('70.0')
  expect(full.querySelector('[data-label="farm"]')?.getAttribute('x')).not.toBe('70.0')
  expect(full.querySelectorAll('image').length).toBe(1)
  expect(full.querySelector('image')?.getAttribute('href')).toContain('overview')
  expect(off.querySelector('image')?.getAttribute('href')).toContain('restPhoto')
  expect(off.querySelector('[data-route]')).toBeNull()
  expect(off.documentElement.textContent).not.toContain(' km')
  expect(xml(renderPoster(p,'group:both')).documentElement.textContent).toContain('Pai')
  p.output.placeText={[dayKey]:{farm:'category'}}
  expect(xml(renderPoster(p,dayKey)).querySelector('[data-label]')?.textContent).toBe('stay')
  p.output.placeVisibility[dayKey]={farm:false}
  expect(xml(renderPoster(p,dayKey)).documentElement.textContent).not.toContain('Farmstay')
  expect(xml(renderPoster(p)).documentElement.textContent).toContain('Farmstay')
})

test('export names are unique after slugging and the phone toggle keeps the SVG identical',()=>{
  const p=trip(), ids=p.days.map(d=>d.id)
  p.output.groups.push({id:'a',name:'My group',dayIds:ids},{id:'b',name:'My/group',dayIds:ids})
  const files=posterFiles(p,availablePosters(p))
  expect(new Set(files.map(f=>f.name)).size).toBe(files.length)
  const host=document.createElement('div')
  mountOutput(host,p,()=>{})
  const preview=host.querySelector('#poster-preview')!.innerHTML
  const phone=host.querySelector<HTMLInputElement>('#poster-phone')!
  phone.checked=true
  phone.dispatchEvent(new Event('change'))
  expect(host.querySelector<HTMLElement>('#poster-preview')!.style.width).toBe('375px')
  expect(host.querySelector('#poster-preview')!.innerHTML).toBe(preview)
})
