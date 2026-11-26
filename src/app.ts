import {parseTrack, type Track} from './track'
import {poster} from './poster'
const field = (id:string) => document.querySelector<HTMLInputElement>('#'+id)!
const input = field('file'), title = field('title'), save = field('save')
const preview = field('preview'), status = field('status')
let track:Track = [], revision=0
function render() { preview.innerHTML=poster(track,title.value) }
input.onchange=async () => {
  const file=input.files?.[0]
  if (!file) return
  const id=++revision
  save.disabled=true
  try {
    const data=parseTrack(await file.text())
    if (id !== revision) return
    track=data
    title.value=file.name.replace(/\.gpx$/i,'').slice(0,50)
    title.disabled=false
    render()
    status.textContent=file.name
  } catch (e) {
    if (id===revision) status.textContent=(e as Error).message
  } finally {
    if (id===revision) {save.disabled=!track.length; input.value=''}
  }
}
title.oninput=render
save.onclick=async () => {
  const name=title.value.trim() || 'Trip'
  const id=revision
  const url=URL.createObjectURL(new Blob([preview.innerHTML],{type:'image/svg+xml;charset=utf-8'}))
  save.disabled=true
  try {
    const img=new Image()
    img.src=url
    await img.decode()
    const canvas=document.createElement('canvas')
    canvas.width=1080; canvas.height=1350
    canvas.getContext('2d')!.drawImage(img,0,0)
    const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',0.95))
    if (!blob) throw new Error()
    const a=document.createElement('a')
    a.href=URL.createObjectURL(blob); a.download=name+'.jpg'; a.click()
    setTimeout(()=>URL.revokeObjectURL(a.href),60000)
    if (revision===id) status.textContent='JPG ready · '+name
  } catch {
    if (revision===id) status.textContent='Could not export the poster. Please try again.'
  } finally {
    URL.revokeObjectURL(url)
    if (revision===id) save.disabled=false
  }
}
