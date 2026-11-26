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
const importTools = node('import-tools')
const backupTools = node('backup-tools')
const tabs = document.querySelector<HTMLElement>('.tabs')!
const stepper = node('wizard-stepper')
const wizardHead = node('wizard-head')
const wizardHeading = node('wizard-heading')
const wizardGuide = node('wizard-guide')
const wizardExtra = node('wizard-step-extra')
const wizardNav = node('wizard-nav')
const wizardBack = node<HTMLButtonElement>('wizard-back')
const wizardNext = node<HTMLButtonElement>('wizard-next')

const steps = [
  { label: 'Import GPX', title: 'Step 1: Import GPX & Order', guide: 'Upload one or more GPX files, check their order, and exclude duplicate recordings. You can also restore a saved backup or start with a photo-only rest day.' },
  { label: 'Split days', title: 'Step 2: Split Days & Rest Days', guide: 'Pick a day, click the map or elevation profile to set boundaries, rename or recolour days, and insert rest days.' },
  { label: 'Places', title: 'Step 3: Places & Visits', guide: 'Review imported GPX waypoints, add stops by coordinates or map click, choose which places print on posters, and record overnight stays.' },
  { label: 'Photos', title: 'Step 4: Photos & Crops', guide: 'Assign photos to the full trip or a specific day, pick a lead photo, adjust crops, and approve photo GPS pins.' },
  { label: 'Style & export', title: 'Step 5: Style, Labels & Export', guide: 'Use the Poster studio on the right to customize title, colours, and map labels, group days, and download JPG, PNG, or ZIP posters.' },
] as const

let project = newProject()
let revision = 0
let mode: 'wizard' | 'full' = 'wizard'
let step = 1
let fullTab: 'itinerary' | 'assets' = 'itinerary'

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
  const section = mode === 'full' ? 'all' : step === 1 ? 'recordings' : step === 2 ? 'days' : undefined
  if (!section) return
  mountItinerary(itinerary, project, () => { showAssets(); showOutput(); changed() }, mergeDay, section)
}
function showAssets() {
  const section = mode === 'full' ? 'all' : step === 3 ? 'places' : step === 4 ? 'photos' : undefined
  if (!section) return
  mountAssets(assets, project, () => { showOutput(); changed() }, section)
}
function showOutput() {
  mountOutput(output, project, changed, mode === 'full' || step === 5 ? 'full' : 'preview')
}

function syncChrome() {
  const wizard = mode === 'wizard'
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
  })
  stepper.hidden = wizardHead.hidden = wizardNav.hidden = !wizard
  tabs.hidden = wizard
  importTools.hidden = wizard && step !== 1
  backupTools.hidden = wizard && step !== 1 && step !== 5
  itinerary.hidden = wizard ? step > 2 : fullTab !== 'itinerary'
  assets.hidden = wizard ? (step !== 3 && step !== 4) : fullTab !== 'assets'
  wizardExtra.replaceChildren()
  if (wizard) {
    const info = steps[step - 1]
    wizardHeading.textContent = info.title
    wizardGuide.textContent = info.guide
    document.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button => {
      if (Number(button.dataset.step) === step) button.setAttribute('aria-current', 'step')
      else button.removeAttribute('aria-current')
    })
    wizardBack.disabled = step === 1
    wizardNext.hidden = step === steps.length
    if (step < steps.length) wizardNext.textContent = 'Next: ' + steps[step].label
    if (step === 5) {
      const tip = document.createElement('p')
      tip.className = 'wizard-tip'
      tip.textContent = 'Your trip saves automatically in this browser. Download a backup file above if you plan to move browsers or clear site data.'
      wizardExtra.append(tip)
    }
  }
}

function render() {
  syncChrome()
  showItinerary()
  showAssets()
  showOutput()
}

function goStep(next: number, focusHeading = true) {
  step = Math.max(1, Math.min(steps.length, next))
  render()
  if (focusHeading && mode === 'wizard') wizardHeading.focus()
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

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
  button.onclick = () => {
    const next = button.dataset.mode === 'full' ? 'full' : 'wizard'
    if (next === mode) return
    mode = next
    render()
  }
})

document.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button => {
  button.onclick = () => goStep(Number(button.dataset.step))
})
wizardBack.onclick = () => goStep(step - 1)
wizardNext.onclick = () => goStep(step + 1)

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
  button.onclick = () => {
    fullTab = button.dataset.tab === 'assets' ? 'assets' : 'itinerary'
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(item => item.setAttribute('aria-pressed',String(item===button)))
    syncChrome()
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
