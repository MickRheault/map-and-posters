import { asDataUrl, importWaypoints } from './assets'
import { mountAssets } from './assets-ui'
import { importRecording } from './itinerary'
import { mountItinerary } from './itinerary-ui'
import { parseGpx } from './track'
import { downloadBlob, mountOutput } from './output'
import { backup, deleteProjectDay, deleteProjectRecording, newProject, restore, type Project } from './project'
import { loadProject, saveProject } from './storage'
import { createWizard } from './wizard'

const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const fileInput = node<HTMLInputElement>('file')
const restoreInput = node<HTMLInputElement>('restore')
const backupButton = node<HTMLButtonElement>('backup')
const resetButton = node<HTMLButtonElement>('reset-trip')
const openWizardButton = node<HTMLButtonElement>('open-wizard')
const status = node('storage-status')
const message = node('message')
const itinerary = node('itinerary')
const assets = node('assets')
const output = node('output')
const wizardDialog = node<HTMLDialogElement>('wizard-dialog')

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
  mountItinerary(itinerary, project, () => { showAssets(); showOutput(); changed() }, mergeDay, id => deleteProjectDay(project, id), id => deleteProjectRecording(project, id))
}
function showAssets() {
  mountAssets(assets, project, () => { showOutput(); changed() })
}
function showOutput() {
  mountOutput(output, project, changed)
}
function renderEditor() {
  showItinerary()
  showAssets()
  showOutput()
}
function busy(value: boolean) {
  fileInput.disabled = restoreInput.disabled = backupButton.disabled = resetButton.disabled = value
}

async function importGpxFiles(files: File[]): Promise<string> {
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
    if (imported) { changed(); renderEditor() }
    const summary = [imported ? 'Imported '+imported+' GPX '+(imported===1?'file.':'files.') : '', ...errors].filter(Boolean).join(' ')
    message.textContent = summary
    return summary
  } finally { busy(false); fileInput.value='' }
}

function downloadBackup() {
  downloadBlob(new Blob([backup(project)],{type:'application/json'}),'map-and-posters-backup.json')
}

async function restoreBackupFile(file: File): Promise<string> {
  busy(true)
  try {
    const restored=restore(await file.text())
    if ((project.sources.length || project.days.length || project.places.length || project.photos.length)
      && !window.confirm('Replace the current trip with this backup?')) return ''
    const previous=project
    project=restored
    try { renderEditor() }
    catch (error) { project=previous; renderEditor(); throw error }
    changed()
    const summary='Restored '+file.name
    message.textContent=summary
    return summary
  } catch(error) {
    const summary='Could not restore this backup. '+(error as Error).message
    message.textContent=summary
    return summary
  } finally {busy(false); restoreInput.value=''}
}

function resetTrip() {
  const hasData = project.sources.length || project.days.length || project.places.length || project.photos.length
  if (hasData && !window.confirm('Start a new trip? Unsaved changes without a backup will be cleared.')) return
  project = newProject()
  message.textContent = ''
  changed()
  renderEditor()
  wizard.reset()
  wizard.render()
}

const wizard = createWizard(wizardDialog, {
  getProject: () => project,
  importGpx: importGpxFiles,
  downloadBackup,
  restoreBackup: restoreBackupFile,
  deleteRecording: id => deleteProjectRecording(project, id),
  deleteDay: id => deleteProjectDay(project, id),
  resetTrip,
  onMutate: () => { changed(); renderEditor() },
  onExit: () => { renderEditor() },
})

fileInput.onchange = async () => { await importGpxFiles(Array.from(fileInput.files || [])) }
backupButton.onclick = downloadBackup
resetButton.onclick = resetTrip
restoreInput.onchange = async () => {
  const file=restoreInput.files?.[0]
  if (file) await restoreBackupFile(file)
}
openWizardButton.onclick = () => wizard.show()

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
    renderEditor()
    busy(false)
    wizard.show()
  }
}
void start()
