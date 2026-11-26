import {expect,test} from 'bun:test'
import {addPlace,exportGpx,importWaypoints,photoGps,readCoordinates,type Assets} from '../src/assets'
import {mountAssets,visitCandidates} from '../src/assets-ui'
import {importRecording,type Itinerary} from '../src/itinerary'
import {parseTrack} from '../src/track'

function trip():Assets & Itinerary {
  return {places:[],visits:[],photos:[],recordings:[],days:[]}
}
test('reads linked place coordinates in preference to search area and camera center',()=>{
  expect(readCoordinates('https://www.google.com/maps/place/Mae+Tho/@18,98,10z/data=!3d18.25!4d98.20!3d18.238704!4d98.181499')).toEqual({lat:18.238704,lon:98.181499})
  expect(readCoordinates('https://www.openstreetmap.org/?mlat=-2&mlon=0')).toEqual({lat:-2,lon:0})
  expect(readCoordinates('https://maps.google.com/?q=18.1%2C98.2')).toEqual({lat:18.1,lon:98.2})
  expect(readCoordinates(' 0 , -122.5 ')).toEqual({lat:0,lon:-122.5})
  for (const input of ['https://maps.app.goo.gl/example','https://google.com/maps/place/Pai/@18,99,12z','driving 20,170','91,0','2,181',' , ']) expect(readCoordinates(input)).toBeNull()
})
test('coordinate sources cannot replace generated place identity',()=>{
  const source={lat:19,lon:99,id:1,name:'Source name',visible:false}
  const p=addPlace(trip(),'Editor name',source)
  expect(typeof p.id).toBe('string')
  expect(p).toMatchObject({name:'Editor name',visible:true,lat:19,lon:99})
})
test('waypoints start hidden and selected names round trip without changing sources',()=>{
  const p=trip()
  const xml='<gpx xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="0" lon="1"><name>A &amp; B</name><type>Camp</type></wpt><wpt lat="1" lon="2"/><wpt lat=" " lon="0"/></gpx>'
  expect(importWaypoints(p,xml)).toBe(2)
  expect(p.places.map(place=>place.visible)).toEqual([false,false])
  p.places[0].visible=true
  const source='<gpx><trk><trkseg><trkpt lat="0" lon="0"><ele>0</ele><time>2026-01-01T00:00:00Z</time></trkpt></trkseg><trkseg><trkpt lat="3" lon="4"/></trkseg></trk></gpx>'
  importRecording(p,source,'A & B.gpx')
  const exported=exportGpx(p.places,p.recordings), fresh=trip()
  expect(importWaypoints(fresh,exported)).toBe(1)
  expect(fresh.places[0]).toMatchObject({name:'A & B',category:'Camp',lat:0,lon:1})
  expect(parseTrack(exported)).toEqual(parseTrack(source))
  expect(p.recordings[0].xml).toBe(source)
})
test('two visits to one place can independently identify passes or an overnight endpoint',()=>{
  const p=trip()
  const coords=[1,2,3,2,1].map(lon=>'<trkpt lat="0" lon="'+lon+'"/>').join('')
  const recording=importRecording(p,'<gpx><trk><trkseg>'+coords+'</trkseg></trk></gpx>','Loop')
  const place=addPlace(p,'Farm', {lat:0.001,lon:1})
  expect(visitCandidates(p,p.days[0],place).map(c=>c.position.point)).toEqual([0,4])
  const host=document.createElement('div')
  document.body.append(host)
  mountAssets(host,p,()=>{})
  function add(overnight:boolean) {
    const box=Array.from(host.querySelectorAll('details')).find(box=>box.querySelector('summary')?.textContent==='Farm')!
    box.open=true
    box.dispatchEvent(new Event('toggle'))
    const check=box.querySelectorAll('input[type=checkbox]')[1] as HTMLInputElement
    check.checked=overnight;check.dispatchEvent(new Event('change'))
    if (!overnight) (box.querySelectorAll('select')[1] as HTMLSelectElement).selectedIndex=2
    Array.from(box.querySelectorAll('button')).find(b=>b.textContent==='Add visit')!.click()
  }
  add(false);add(true)
  expect(p.visits.map(v=>[v.overnight,v.placeId,v.position])).toEqual([
    [false,place.id,{recordingId:recording.id,segment:0,point:0}],
    [true,place.id,{recordingId:recording.id,segment:0,point:4}]
  ])
  expect(place.lat).toBe(0.001)
  host.remove()
})
function taggedJpeg(le:boolean) {
  const prefix=Uint8Array.of(0xff,0xd8,0xff,0xe1,0,0,69,120,105,102,0,0)
  // APP1 length counts its two size bytes and the Exif prefix.
  const tiff=new Uint8Array(128),d=new DataView(tiff.buffer)
  const set16=(p:number,n:number)=>d.setUint16(p,n,le), set32=(p:number,n:number)=>d.setUint32(p,n,le)
  set16(0,le?0x4949:0x4d4d);set16(2,42);set32(4,8);set16(8,1)
  set16(10,0x8825);set16(12,4);set32(14,1);set32(18,26)
  set16(26,4)
  for(let entry=0;entry<4;entry++){
    const at=28+12*entry,ref=entry%2===0
    set16(at,entry+1);set16(at+2,ref?2:5);set32(at+4,ref?2:3)
    if(ref) tiff[at+8]=entry===0?83:69
    else {
      const offset=entry===1?80:104;set32(at+8,offset)
      ;[entry===1?17:98,30,0].forEach((n,i)=>{set32(offset+8*i,n);set32(offset+8*i+4,1)})
    }
  }
  const out=new Uint8Array(12+tiff.length)
  out.set(prefix);out.set(tiff,12)
  new DataView(out.buffer).setUint16(4,tiff.length+8)
  return out.buffer
}
test('photo GPS suggestions support either TIFF byte order and malformed images',()=>{
  for(const littleEndian of [true,false]) expect(photoGps(taggedJpeg(littleEndian))).toEqual({lat:-17.5,lon:98.5})
  expect(photoGps(new Uint8Array([255,216,255,225,0,25,69,120]).buffer)).toBeUndefined()
  expect(photoGps(new ArrayBuffer(0))).toBeUndefined()
})
test('photo controls change assignment, lead image, crop, order, and approved GPS pin',()=>{
  const p=trip()
  importRecording(p,'<gpx><trk><trkseg><trkpt lat="0" lon="0"/></trkseg></trk></gpx>','Trip')
  for(const [i,id] of ['first','second'].entries()) p.photos.push({id,name:id+'.jpg',src:'data:image/jpeg;base64,',original:'data:image/jpeg;base64,',
    dayId:p.days[0].id,hero:i===0,cropX:.5,cropY:.5,zoom:1,width:400,height:300,gps:{lat:3,lon:4}})
  const host=document.createElement('div')
  document.body.append(host)
  mountAssets(host,p,()=>{})
  const panel=()=>Array.from(host.querySelectorAll('details')).find(el=>el.querySelector('summary')?.textContent==='second.jpg')!
  const control=(name:string)=>Array.from(panel().querySelectorAll('label')).find(l=>l.textContent?.startsWith(name))!.querySelector('input')!
  control('Use as lead').click()
  expect(p.photos.map(f=>f.hero)).toEqual([false,true])
  const slider=control('Crop zoom'); slider.value='2.4'; slider.dispatchEvent(new Event('change'))
  expect(p.photos[1].zoom).toBe(2.4)
  function act(text:string) { Array.from(panel().querySelectorAll('button')).find(b=>b.textContent===text)!.click() }
  act('Move photo earlier')
  expect(p.photos[0].id).toBe('second')
  expect(p.places).toHaveLength(0)
  act('Add place from photo GPS')
  expect(p.places[0]).toMatchObject({lat:3,lon:4,name:'second',visible:true})
  expect(p.visits[0].dayId).toBe(p.days[0].id)
  expect(p.photos[0].placeId).toBe(p.places[0].id)
  const day=panel().querySelector('select')!
  day.value='';day.dispatchEvent(new Event('change'))
  expect(p.photos[0].dayId).toBe('')
  host.remove()
})
