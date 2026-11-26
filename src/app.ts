import { asDataUrl, importWaypoints } from './assets'
import { mountAssets } from './assets-ui'
import { importRecording } from './itinerary'
import { mountItinerary } from './itinerary-ui'
import { parseGpx } from './track'
import { mountOutput } from './output'
import { backup, newProject, restore, type Project } from './project'
import { loadProject, saveProject } from './storage'

const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const fileInput = node<HTMLInputElement>('file')
const restoreInput = node<HTMLInputElement>('restore')
const backupButton = node<HTMLButtonElement>('backup')
const status = node('storage-status')
const message = node('message')
const itinerary = node('itinerary')
const assets = node('assets')
const output = node('output')
let project = newProject()
let revision = 0

function changed() {
  const edit = ++revision
  status.textContent = 'Saving…'
  void saveProject(project).then(() => {
    if (edit === revision) status.textContent = 'Saved on this device'
  }).catch(() => {
    if (edit === revision) status.textContent = 'Local save unavailable · Download a backup'
  })
}

function mergeDay(removed: string, kept: string) {
  for (const item of [...project.visits,...project.photos]) if (item.dayId===removed) item.dayId=kept
  const out = project.output
  for (const group of out.groups)
    group.dayIds = Array.from(new Set(group.dayIds.map(id=>id===removed ? kept : id)))
  const oldKey = 'day:'+removed
  const newKey = 'day:'+kept
  if (out.active === oldKey) out.active = newKey
  out.selected = Array.from(new Set(out.selected.map(key => key === oldKey ? newKey : key)))
  for (const settings of [out.labels, out.placeVisibility, out.placeText]) {
    if (!settings) continue
    if (settings[oldKey]) {
      Object.assign(settings, { [newKey]: { ...settings[oldKey], ...settings[newKey] } })
      delete settings[oldKey]
    }
  }
}

function showItinerary() {
  mountItinerary(itinerary, project, () => { showAssets(); showOutput(); changed() }, mergeDay)
}
function showAssets() {
  mountAssets(assets, project, () => { showOutput(); changed() })
}
function showOutput() {
  mountOutput(output, project, changed)
}
function render() {
  showItinerary()
  showAssets()
  showOutput()
}
function busy(value: boolean) {
  fileInput.disabled = restoreInput.disabled = backupButton.disabled = value
}

fileInput.onchange = async () => {
  const files = Array.from(fileInput.files || [])
  busy(true)
  const errors: string[] = []
  let imported = 0
  try {
    for (const file of files) {
      try {
        const [xml,original] = await Promise.all([file.text(),asDataUrl(file)])
        const doc=parseGpx(xml)
        const waypoints: Pick<Project,'places'> = {places:[]}
        const count = importWaypoints(waypoints,doc)
        try {
          importRecording(project,xml,file.name,doc)
          if (project.recordings.length===1 && project.output.title===newProject().output.title)
            project.output.title=file.name.replace(/\.gpx$/i,'').slice(0,80)
        }
        catch(error) { if (!count) throw error }
        project.places.push(...waypoints.places)
        project.sources.push({name:file.name, original})
        imported++
      } catch(error) { errors.push(file.name+' — '+(error as Error).message) }
    }
    if (imported) { changed(); render() }
    message.textContent = [imported ? 'Imported '+imported+' GPX '+(imported===1?'file.':'files.') : '', ...errors].filter(Boolean).join(' ')
  } finally { busy(false); fileInput.value='' }
}

backupButton.onclick = () => {
  const href=URL.createObjectURL(new Blob([backup(project)],{type:'application/json'}))
  const link=document.createElement('a')
  link.download='map-and-posters-backup.json'
  link.href=href
  link.click()
  setTimeout(()=>URL.revokeObjectURL(href),60000)
}

restoreInput.onchange = async () => {
  const file=restoreInput.files?.[0]
  if (!file) return
  busy(true)
  try {
    const restored=restore(await file.text())
    if ((project.sources.length || project.days.length || project.places.length || project.photos.length)
      && !window.confirm('Replace the current trip with this backup?')) return
    const previous=project
    project=restored
    try { render() }
    catch (error) { project=previous; render(); throw error }
    changed()
    message.textContent='Restored '+file.name
  } catch(error) {
    message.textContent='Could not restore this backup. '+(error as Error).message
  } finally {busy(false); restoreInput.value=''}
}

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
  button.onclick = () => {
    const tab = button.dataset.tab
    itinerary.hidden = tab !== 'itinerary'
    assets.hidden = tab !== 'assets'
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(item => item.setAttribute('aria-pressed',String(item===button)))
  }
})

async function start() {
  busy(true)
  try {
    project = await loadProject() || project
    status.textContent = project.sources.length ? 'Saved on this device' : ''
  } catch {
    status.textContent='Local save unavailable · Download a backup'
  } finally {
    render()
    busy(false)
  }
}
void start()
