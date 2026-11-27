import { addPlace, readCoordinates, readPhoto, type Photo, type Place } from './assets'
import { visitCandidates } from './assets-ui'
import { combinedRanges, dayName, insertRestDay, moveRecording, possibleOverlap, setBoundary, type Day, type PointRef } from './itinerary'
import { downloadBlob, posterFiles, rasterize, slug, wireLabelEditing, zipFiles } from './output'
import { availablePosters, renderPoster } from './poster'
import type { Project } from './project'
import { layout, type Point } from './track'

export interface WizardHooks {
  getProject: () => Project
  importGpx: (files: File[]) => Promise<string>
  downloadBackup: () => void
  restoreBackup: (file: File) => Promise<string>
  deleteRecording: (recordingId: string) => void
  deleteDay: (dayId: string) => void
  resetTrip: () => void
  onMutate: () => void
  onExit: () => void
}

const STEP_TITLES = [
  'Add your GPX',
  'Split into days',
  'Pick stops',
  'Add photos',
  'Ready to download',
] as const

type Sample = PointRef & { x: number, y: number, km: number, run: number }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (className) node.className = className
  return node
}

function btn(text: string, click: () => void, className = '') {
  const node = el('button', text, className)
  node.type = 'button'
  node.onclick = click
  return node
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

function routeSilhouette(segments: Point[][], stroke = '#206248'): HTMLElement | null {
  if (!segments.length) return null
  const bounds = layout(segments)
  const scale = Math.min(340 / (bounds.east - bounds.west || 1e-8), 116 / (bounds.north - bounds.south || 1e-8))
  const px = (x: number) => (180 + (x - (bounds.east + bounds.west) / 2) * scale).toFixed(1)
  const py = (y: number) => (70 - (y - (bounds.north + bounds.south) / 2) * scale).toFixed(1)
  const svg = svgEl('svg', { viewBox: '0 0 360 140', class: 'wiz-mini-map', 'aria-label': 'Route preview' })
  for (const line of bounds.lines) {
    const d = line.map((p, i) => (i ? 'L' : 'M') + px(p.x) + ',' + py(p.y)).join('')
    svg.append(svgEl('path', { d, fill: 'none', stroke, 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
  }
  const wrap = el('div', '', 'wiz-route-card')
  wrap.append(svg, el('span', bounds.km.toFixed(1) + ' km', 'wiz-badge'))
  return wrap
}

function overnightPosition(project: Project, place: Place, day: Day) {
  if (day.rest) return undefined
  const end = day.ranges.filter(r => project.recordings.some(rec => rec.id === r.recordingId && rec.included)).at(-1)
  const pass = visitCandidates(project, day, place).at(-1)
  return end ? { recordingId: end.recordingId, segment: end.segment, point: end.end } : pass?.position
}

export function createWizard(dialog: HTMLDialogElement, hooks: WizardHooks) {
  const heading = dialog.querySelector<HTMLElement>('#wizard-heading')!
  const content = dialog.querySelector<HTMLElement>('#wizard-content')!
  const statusEl = dialog.querySelector<HTMLElement>('#wizard-status')!
  const counterEl = dialog.querySelector<HTMLElement>('#wizard-counter')!
  const foot = dialog.querySelector<HTMLElement>('#wizard-foot')!
  const backBtn = dialog.querySelector<HTMLButtonElement>('#wizard-back')!
  const nextBtn = dialog.querySelector<HTMLButtonElement>('#wizard-next')!
  const exitBtn = dialog.querySelector<HTMLButtonElement>('#wizard-exit')!

  let step = 1
  let activeDayId = ''
  let showAddPlace = false
  let photoDayId = ''
  let expandedCropPhotoId = ''
  let statusText = ''
  let busy = false

  function isOpen() {
    return dialog.hasAttribute('open')
  }

  function show() {
    if (isOpen()) return
    // Populate heading and content before showModal() so screen readers announce the accessible name immediately.
    renderContent()
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    heading.focus()
  }

  function hide() {
    if (!isOpen()) return
    if (typeof dialog.close === 'function') dialog.close('exit')
    else {
      dialog.removeAttribute('open')
      hooks.onExit()
    }
  }

  dialog.addEventListener('close', () => {
    dialog.returnValue = ''
    hooks.onExit()
  })

  exitBtn.onclick = () => hide()

  function go(next: number) {
    step = Math.max(1, Math.min(STEP_TITLES.length, next))
    statusText = ''
    render()
    heading.focus()
  }

  dialog.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button => {
    button.onclick = () => go(Number(button.dataset.step))
  })
  backBtn.onclick = () => go(step - 1)

  function setStatus(text: string) {
    statusText = text
    statusEl.textContent = text
  }

  function mutate() {
    hooks.onMutate()
    render()
  }

  async function handleGpxFiles(files: File[]) {
    if (!files.length) return
    busy = true
    setStatus('Reading GPX…')
    render()
    try {
      setStatus(await hooks.importGpx(files))
    } finally {
      busy = false
      render()
    }
  }

  function restoreLabel() {
    const restoreInput = el('input')
    restoreInput.id = 'wizard-restore'
    restoreInput.type = 'file'
    restoreInput.accept = '.json'
    restoreInput.onchange = async () => {
      const file = restoreInput.files?.[0]
      restoreInput.value = ''
      if (!file) return
      setStatus(await hooks.restoreBackup(file))
      render()
    }
    const label = el('label', 'Restore backup', 'wiz-link-file')
    label.append(restoreInput)
    return label
  }

  function renderStep1(project: Project) {
    const hasContent = project.recordings.length > 0 || project.days.length > 0

    const gpxInput = el('input')
    gpxInput.id = 'wizard-gpx'
    gpxInput.type = 'file'
    gpxInput.multiple = true
    gpxInput.accept = '.gpx,application/gpx+xml'
    gpxInput.disabled = busy
    gpxInput.onchange = async () => {
      const files = Array.from(gpxInput.files || [])
      gpxInput.value = ''
      await handleGpxFiles(files)
    }

    if (!hasContent) {
      const zone = el('div', '', 'wiz-dropzone')
      const pick = el('label', 'Choose GPX files', 'wiz-cta-file')
      pick.append(gpxInput)
      zone.append(pick)
      zone.ondragover = e => { e.preventDefault(); zone.classList.add('is-drag') }
      zone.ondragleave = () => zone.classList.remove('is-drag')
      zone.ondrop = e => {
        e.preventDefault()
        zone.classList.remove('is-drag')
        const files = Array.from(e.dataTransfer?.files || []).filter(f => /\.gpx$/i.test(f.name) || f.type.includes('gpx'))
        void handleGpxFiles(files)
      }

      const restBtn = btn('Start with a rest day', () => {
        const rest = insertRestDay(project, 0)
        activeDayId = rest.id
        hooks.onMutate()
        go(2)
      }, 'wiz-link')

      const alt = el('div', '', 'wiz-alt-links')
      alt.append(restoreLabel(), el('span', '·', 'wiz-sep'), restBtn)
      content.append(zone, alt)
      return
    }

    const preview = routeSilhouette(project.recordings.filter(r => r.included).flatMap(r => r.track))
    if (preview) content.append(preview)

    if (project.recordings.length) {
      const list = el('div', '', 'wiz-list')
      project.recordings.forEach((rec, i) => {
        const row = el('div', '', 'wiz-rec')
        const check = el('input')
        check.type = 'checkbox'
        check.checked = rec.included
        check.onchange = () => { rec.included = check.checked; mutate() }
        const label = el('label', '', 'wiz-check')
        label.append(check, el('span', rec.name))
        row.append(label)

        const overlaps = project.recordings.slice(0, i).filter(other => possibleOverlap(rec, other))
        if (overlaps.length) row.append(el('span', 'Possible overlap', 'wiz-warn'))

        const controls = el('div', '', 'wiz-arrows')
        if (project.recordings.length > 1) {
          const up = btn('↑', () => { moveRecording(project, i, -1); mutate() }, 'wiz-icon')
          up.disabled = i === 0
          up.setAttribute('aria-label', 'Move ' + rec.name + ' earlier')
          const down = btn('↓', () => { moveRecording(project, i, 1); mutate() }, 'wiz-icon')
          down.disabled = i === project.recordings.length - 1
          down.setAttribute('aria-label', 'Move ' + rec.name + ' later')
          controls.append(up, down)
        }
        const del = btn('×', () => { hooks.deleteRecording(rec.id); setStatus(''); mutate() }, 'wiz-icon wiz-danger')
        del.setAttribute('aria-label', 'Delete ' + rec.name)
        controls.append(del)
        row.append(controls)
        list.append(row)
      })
      content.append(list)
    }

    const addMore = el('label', '+ Add GPX', 'wiz-ghost-file')
    addMore.append(gpxInput)
    const tools = el('div', '', 'wiz-inline-tools')
    tools.append(addMore, restoreLabel(), btn('New trip', () => hooks.resetTrip(), 'wiz-link wiz-danger'))
    content.append(tools)
  }

  function renderStep2(project: Project) {
    if (!project.days.length) {
      content.append(btn('+ Rest day', () => {
        const rest = insertRestDay(project, 0)
        activeDayId = rest.id
        mutate()
      }, 'wiz-ghost'))
      return
    }
    if (!project.days.some(d => d.id === activeDayId)) activeDayId = project.days[0].id
    const index = project.days.findIndex(d => d.id === activeDayId)
    const day = project.days[index]

    const pills = el('div', '', 'wiz-pills')
    project.days.forEach(d => {
      const pill = btn(dayName(project, d), () => { activeDayId = d.id; render() }, 'wiz-day-pill')
      pill.setAttribute('aria-pressed', String(d.id === day.id))
      pill.style.setProperty('--day-color', d.color)
      pills.append(pill)
    })
    pills.append(btn('+ Rest day', () => {
      const rest = insertRestDay(project, index + 1)
      activeDayId = rest.id
      mutate()
    }, 'wiz-pill-add'))
    content.append(pills)

    const deleteBtn = () => btn('Delete day', () => {
      hooks.deleteDay(day.id)
      const next = project.days[Math.min(index, project.days.length - 1)]
      activeDayId = next?.id || ''
      setStatus('')
      mutate()
    }, 'wiz-link wiz-danger')

    if (day.rest) {
      const restRow = el('div', '', 'wiz-rest-row')
      const nameInput = el('input', '', 'wiz-input')
      nameInput.type = 'text'
      nameInput.maxLength = 80
      nameInput.placeholder = 'Rest day name (e.g. Pai)'
      nameInput.setAttribute('aria-label', 'Day name')
      nameInput.value = day.name
      nameInput.onchange = () => { day.name = nameInput.value.trim(); mutate() }
      restRow.append(nameInput, deleteBtn())
      content.append(restRow)
      return
    }

    const ranges = combinedRanges([day])
    const sources = new Map(project.recordings.map(r => [r.id, r]))
    const visible = ranges.filter(r => sources.get(r.recordingId)?.included)
    const segments: Point[][] = visible.map(r => sources.get(r.recordingId)!.track[r.segment].slice(r.start, r.end + 1))
    if (!segments.length) {
      const box = el('div', '', 'wiz-empty-day')
      box.append(el('p', 'This day’s GPX is unchecked in Step 1.', 'wiz-meta'))
      const row = el('div', '', 'wiz-inline-tools')
      row.append(
        btn('Include GPX', () => {
          for (const r of ranges) {
            const rec = sources.get(r.recordingId)
            if (rec) rec.included = true
          }
          mutate()
        }, 'wiz-ghost'),
        deleteBtn(),
      )
      box.append(row)
      content.append(box)
      return
    }

    const bounds = layout(segments)
    const scale = Math.min(372 / (bounds.east - bounds.west || 1e-8), 172 / (bounds.north - bounds.south || 1e-8))
    const projectAxis = (x: number, center: number, offset: number) => offset + (x - center) * scale
    const samples: Sample[] = []
    bounds.lines.forEach((line, run) => {
      const r = visible[run]
      line.forEach((p, i) => samples.push({
        recordingId: r.recordingId, segment: r.segment, point: r.start + i, run, km: p.km,
        x: projectAxis(p.x, (bounds.east + bounds.west) / 2, 200),
        y: projectAxis(-p.y, -(bounds.north + bounds.south) / 2, 100),
      }))
    })
    if (samples.length < 3) {
      const card = routeSilhouette(segments, day.color)
      if (card) content.append(card)
      const actions = el('div', '', 'wiz-inline-tools')
      actions.append(deleteBtn())
      content.append(actions)
      return
    }

    const map = svgEl('svg', { viewBox: '0 0 400 200', class: 'wiz-split-map', 'aria-label': 'Choose a boundary on the recorded route' })
    const slider = el('input', '', 'wiz-slider')
    slider.type = 'range'
    slider.min = '1'
    slider.max = String(samples.length - 2)
    slider.step = '1'
    slider.setAttribute('aria-label', 'Boundary point')

    const passes = el('select', '', 'wiz-select')
    passes.setAttribute('aria-label', 'Matching visits')
    passes.hidden = true

    const readout = el('span', '', 'wiz-meta')
    let split = Math.floor(samples.length / 2)
    const xy = (q: Sample) => q.x.toFixed(1) + ',' + q.y.toFixed(1)

    function draw() {
      slider.value = String(split)
      const chosen = samples[split]
      readout.textContent = chosen.km.toFixed(1) + ' km  ·  ' + (bounds.km - chosen.km).toFixed(1) + ' km'
      map.replaceChildren()
      let path = '', prevColor = '', prevRun = -1
      const flush = () => {
        if (path) map.prepend(svgEl('path', { fill: 'none', stroke: prevColor, 'stroke-width': '3.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', d: path }))
      }
      for (let i = 0; i < samples.length; i++) {
        const p = samples[i], color = i <= split ? day.color : '#8b948c'
        if (p.run !== prevRun || color !== prevColor) {
          flush()
          const prev = i > 0 && samples[i - 1].run === p.run ? samples[i - 1] : null
          path = prev ? 'M' + xy(prev) : ''
        }
        path += (path ? 'L' : 'M') + xy(p)
        prevRun = p.run
        prevColor = color
      }
      flush()
      map.append(svgEl('circle', { cx: String(chosen.x), cy: String(chosen.y), r: '5.5', fill: '#fff', stroke: '#173b33', 'stroke-width': '2.5' }))
    }

    const setSplit = (v: number) => { split = Math.max(1, Math.min(samples.length - 2, v)); draw() }
    slider.oninput = () => { passes.hidden = true; setSplit(Number(slider.value)) }
    map.onclick = ev => {
      const rect = map.getBoundingClientRect()
      const loc = { x: (ev.clientX - rect.left) / rect.width * 400, y: (ev.clientY - rect.top) / rect.height * 200 }
      const ds = samples.map(p => Math.hypot(p.x - loc.x, p.y - loc.y))
      let best = Infinity
      for (let i = 1; i < ds.length - 1; i++) best = Math.min(best, ds[i])
      const candidates: number[] = []
      for (let i = 1; i < ds.length - 1; i++) {
        if (ds[i] > best + 3) continue
        const first = i
        while (i + 1 < ds.length - 1 && samples[i + 1].run === samples[first].run && Math.abs(ds[i + 1] - ds[first]) < 1e-6) i++
        const before = first === 1 || samples[first - 1].run !== samples[first].run ? Infinity : ds[first - 1]
        const after = i === ds.length - 2 || samples[i + 1].run !== samples[first].run ? Infinity : ds[i + 1]
        if (ds[first] <= before && ds[first] <= after) candidates.push(first)
      }
      if (!candidates.length) return
      passes.replaceChildren(...candidates.map((idx, n) => {
        const o = el('option', 'Pass ' + (n + 1) + ' · ' + samples[idx].km.toFixed(1) + ' km')
        o.value = String(idx)
        return o
      }))
      passes.hidden = candidates.length < 2
      setSplit(candidates[0])
    }
    passes.onchange = () => setSplit(Number(passes.value))

    const bar = el('div', '', 'wiz-split-bar')
    const barActions = el('div', '', 'wiz-stop-actions')
    barActions.append(deleteBtn(), btn('Split here', () => {
      try {
        const nextDay = setBoundary(project, day, null, samples[split])
        activeDayId = nextDay.id
        setStatus('')
        mutate()
      } catch (e) { setStatus((e as Error).message) }
    }, 'wiz-ghost'))
    bar.append(readout, barActions)

    draw()
    content.append(map, passes, slider, bar)
  }

  function toggleOvernight(project: Project, place: Place, day: Day) {
    const existing = project.visits.find(v => v.placeId === place.id && v.dayId === day.id && v.overnight)
    if (existing) {
      project.visits = project.visits.filter(v => v.id !== existing.id)
    } else {
      project.visits.push({
        id: crypto.randomUUID(),
        placeId: place.id,
        dayId: day.id,
        overnight: true,
        position: overnightPosition(project, place, day),
      })
    }
    mutate()
  }

  function renderStep3(project: Project) {
    if (project.places.length) {
      const list = el('div', '', 'wiz-list')
      for (const place of project.places) {
        const row = el('div', '', 'wiz-stop')
        const cb = el('input')
        cb.type = 'checkbox'
        cb.checked = place.visible
        cb.onchange = () => { place.visible = cb.checked; mutate() }
        const lbl = el('label', '', 'wiz-check')
        lbl.append(cb, el('span', place.name))
        row.append(lbl)

        if (place.visible && project.days.length) {
          const existing = project.visits.find(v => v.placeId === place.id && v.overnight)
          let chosenDay = project.days.find(d => d.id === existing?.dayId) || project.days[0]
          const actions = el('div', '', 'wiz-stop-actions')
          if (project.days.length > 1) {
            const sel = el('select', '', 'wiz-select-sm')
            sel.setAttribute('aria-label', 'Day for ' + place.name)
            for (const d of project.days) {
              const opt = el('option', dayName(project, d))
              opt.value = d.id
              sel.add(opt)
            }
            sel.value = chosenDay.id
            sel.onchange = () => {
              chosenDay = project.days.find(d => d.id === sel.value) || project.days[0]
              if (existing) {
                existing.dayId = chosenDay.id
                existing.position = overnightPosition(project, place, chosenDay)
                mutate()
              }
            }
            actions.append(sel)
          }
          const night = btn('Overnight', () => toggleOvernight(project, place, chosenDay), 'wiz-chip')
          night.setAttribute('aria-pressed', String(Boolean(existing)))
          actions.append(night)
          row.append(actions)
        }
        list.append(row)
      }
      content.append(list)
    }

    const toggleAdd = btn(showAddPlace ? 'Cancel' : '+ Add place', () => {
      showAddPlace = !showAddPlace
      setStatus('')
      render()
    }, 'wiz-ghost')
    content.append(toggleAdd)

    if (!showAddPlace) return
    const form = el('div', '', 'wiz-add-row')
    const nameIn = el('input', '', 'wiz-input')
    nameIn.placeholder = 'Place name'
    nameIn.setAttribute('aria-label', 'Place name')
    const locIn = el('input', '', 'wiz-input')
    locIn.placeholder = 'Lat, lon or map link'
    locIn.setAttribute('aria-label', 'Location')
    const add = btn('Add', () => {
      const coords = readCoordinates(locIn.value)
      if (!coords) { setStatus('Paste coordinates or a map link.'); return }
      addPlace(project, nameIn.value, coords)
      showAddPlace = false
      setStatus('')
      mutate()
    }, 'wiz-primary')
    form.append(nameIn, locIn, add)
    content.append(form)
  }

  function renderStep4(project: Project) {
    const bar = el('div', '', 'wiz-photo-bar')
    const input = el('input')
    input.id = 'wizard-photos'
    input.type = 'file'
    input.multiple = true
    input.accept = 'image/jpeg,image/png,.jpg,.jpeg,.png'
    input.disabled = busy

    const daySel = el('select', '', 'wiz-select')
    daySel.id = 'wizard-photo-day'
    daySel.setAttribute('aria-label', 'Assign photos to')
    const fullOpt = el('option', 'Full trip')
    fullOpt.value = ''
    daySel.add(fullOpt)
    for (const d of project.days) {
      const opt = el('option', dayName(project, d))
      opt.value = d.id
      daySel.add(opt)
    }
    if (photoDayId && project.days.some(d => d.id === photoDayId)) daySel.value = photoDayId
    else photoDayId = ''
    daySel.onchange = () => { photoDayId = daySel.value }

    input.onchange = async () => {
      const batch = Array.from(input.files || [])
      input.value = ''
      if (!batch.length) return
      busy = true
      setStatus('Adding photos…')
      render()
      const loaded: Photo[] = [], errors: string[] = []
      for (const file of batch) {
        try { loaded.push(await readPhoto(file, photoDayId)) } catch { errors.push(file.name) }
      }
      project.photos.push(...loaded)
      busy = false
      setStatus(errors.length ? 'Could not read ' + errors.join(', ') : '')
      if (loaded.length) mutate()
      else render()
    }

    const pick = el('label', 'Choose photos', 'wiz-cta-file')
    pick.append(input)
    bar.append(pick)
    if (project.days.length) bar.append(daySel)
    content.append(bar)

    if (!project.photos.length) return
    const grid = el('div', '', 'wiz-photo-grid')
    project.photos.forEach((photo, i) => {
      const card = el('div', '', 'wiz-photo')
      const img = el('img')
      img.src = photo.src
      img.alt = photo.name
      const meta = el('div', '', 'wiz-photo-actions')
      const lead = btn('Lead', () => {
        const next = !photo.hero
        if (next) for (const s of project.photos) if (s.dayId === photo.dayId) s.hero = false
        photo.hero = next
        mutate()
      }, 'wiz-chip')
      lead.setAttribute('aria-pressed', String(photo.hero))

      const cropBtn = btn('Crop', () => {
        expandedCropPhotoId = expandedCropPhotoId === photo.id ? '' : photo.id
        render()
      }, 'wiz-chip')
      cropBtn.setAttribute('aria-pressed', String(expandedCropPhotoId === photo.id))
      meta.append(lead, cropBtn)

      if (photo.gps) {
        const pinned = Boolean(photo.placeId && project.places.some(p => p.id === photo.placeId))
        const pinBtn = btn('Pin GPS', () => {
          if (pinned) {
            const placeId = photo.placeId!
            project.places = project.places.filter(p => p.id !== placeId)
            project.visits = project.visits.filter(v => v.placeId !== placeId)
            delete photo.placeId
          } else {
            const place = addPlace(project, photo.name.replace(/\.[^.]+$/, ''), photo.gps!)
            photo.placeId = place.id
            if (photo.dayId) project.visits.push({ id: crypto.randomUUID(), placeId: place.id, dayId: photo.dayId, overnight: false })
          }
          mutate()
        }, 'wiz-chip')
        pinBtn.setAttribute('aria-pressed', String(pinned))
        meta.append(pinBtn)
      }
      const del = btn('×', () => { project.photos.splice(i, 1); mutate() }, 'wiz-icon')
      del.setAttribute('aria-label', 'Remove ' + photo.name)
      meta.append(del)
      card.append(img, meta)

      if (expandedCropPhotoId === photo.id) {
        const sliders = el('div', '', 'wiz-crop-box')
        for (const [labelText, key, min, max] of [['Horizontal crop', 'cropX', 0, 1], ['Vertical crop', 'cropY', 0, 1], ['Crop zoom', 'zoom', 1, 3]] as const) {
          const s = el('input')
          s.type = 'range'; s.min = String(min); s.max = String(max); s.step = '0.01'; s.value = String(photo[key])
          s.setAttribute('aria-label', labelText)
          s.onchange = () => { photo[key] = Number(s.value); mutate() }
          const l = el('label', labelText.split(' ')[0] + ' ')
          l.append(s)
          sliders.append(l)
        }
        card.append(sliders)
      }
      grid.append(card)
    })
    content.append(grid)
  }

  function renderStep5(project: Project) {
    if (!project.days.length && !project.photos.length) {
      content.append(btn('Go to Step 1', () => go(1), 'wiz-ghost'))
      return
    }
    const targets = availablePosters(project)
    const state = project.output
    const target = targets.find(t => t.key === state.active) || targets[0]

    const controls = el('div', '', 'wiz-export-top')
    const titleIn = el('input', '', 'wiz-input')
    titleIn.id = 'wizard-title'
    titleIn.type = 'text'
    titleIn.maxLength = 100
    titleIn.value = state.title
    titleIn.placeholder = 'Trip title'
    titleIn.setAttribute('aria-label', 'Trip title')
    titleIn.onchange = () => { state.title = titleIn.value; mutate() }
    controls.append(titleIn)

    if (targets.length > 1) {
      const targetSel = el('select', '', 'wiz-select')
      targetSel.id = 'wizard-poster-target'
      targetSel.setAttribute('aria-label', 'Poster')
      for (const t of targets) {
        const opt = el('option', t.name)
        opt.value = t.key
        if (t.key === target.key) opt.selected = true
        targetSel.add(opt)
      }
      targetSel.onchange = () => { state.active = targetSel.value; mutate() }
      controls.append(targetSel)
    }

    const phone = el('input')
    phone.id = 'wizard-phone'
    phone.type = 'checkbox'
    phone.checked = state.phone
    phone.onchange = () => { state.phone = phone.checked; mutate() }
    const phoneLbl = el('label', '', 'wiz-check')
    phoneLbl.append(phone, el('span', 'Phone'))
    controls.append(phoneLbl)
    content.append(controls)

    const svgText = renderPoster(project, target.key)
    const preview = el('div', '', 'wiz-preview')
    preview.id = 'wizard-preview'
    if (state.phone) preview.classList.add('is-phone')
    preview.innerHTML = svgText
    wireLabelEditing(preview.querySelector<SVGSVGElement>('svg')!, target.key, state, mutate, dialog)
    content.append(preview)

    const actions = el('div', '', 'wiz-export-bar')
    const fmt = el('select', '', 'wiz-select-sm')
    fmt.id = 'wizard-format'
    fmt.setAttribute('aria-label', 'File format')
    for (const [v, l] of [['jpg', 'JPG'], ['png', 'PNG']] as const) {
      const opt = el('option', l)
      opt.value = v
      if (state.format === v) opt.selected = true
      fmt.add(opt)
    }
    fmt.onchange = () => { state.format = fmt.value === 'png' ? 'png' : 'jpg'; mutate() }

    const files = posterFiles(project, targets)
    const dlBtn = btn('Download ' + state.format.toUpperCase(), async () => {
      dlBtn.disabled = true
      setStatus('Preparing…')
      try {
        const blob = await rasterize(svgText, state.format)
        downloadBlob(blob, files.find(f => f.target.key === target.key)!.name)
        setStatus('Downloaded.')
      } catch (e) { setStatus(e instanceof Error ? e.message : 'Download failed.') }
      finally { dlBtn.disabled = false }
    }, 'wiz-primary')
    dlBtn.id = 'wizard-download'

    actions.append(fmt, dlBtn)
    if (targets.length > 1) {
      const zipBtn = btn('Download all (ZIP)', async () => {
        zipBtn.disabled = true
        setStatus('Packing ZIP…')
        try {
          const format = state.format
          const entries = []
          for (const f of files) {
            const blob = await rasterize(renderPoster(project, f.target.key), format)
            entries.push({ name: f.name, bytes: new Uint8Array(await blob.arrayBuffer()) })
          }
          downloadBlob(zipFiles(entries), slug(state.title) + '-posters.zip')
          setStatus('ZIP downloaded.')
        } catch (e) { setStatus(e instanceof Error ? e.message : 'ZIP failed.') }
        finally { zipBtn.disabled = false }
      }, 'wiz-ghost')
      zipBtn.id = 'wizard-download-zip'
      actions.append(zipBtn)
    }
    const backupBtn = btn('Save backup', () => hooks.downloadBackup(), 'wiz-link')
    backupBtn.id = 'wizard-backup'
    actions.append(backupBtn)
    content.append(actions)
  }

  function renderContent() {
    const project = hooks.getProject()
    dialog.dataset.step = String(step)
    counterEl.textContent = step + ' / ' + STEP_TITLES.length
    heading.textContent = STEP_TITLES[step - 1]
    statusEl.textContent = statusText
    dialog.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(dot => {
      const num = Number(dot.dataset.step)
      if (num === step) dot.setAttribute('aria-current', 'step')
      else dot.removeAttribute('aria-current')
      dot.classList.toggle('is-done', num < step)
    })

    const stepRenderers = [renderStep1, renderStep2, renderStep3, renderStep4, renderStep5]
    content.replaceChildren()
    stepRenderers[step - 1](project)

    const hasContent = project.recordings.length > 0 || project.days.length > 0 || project.photos.length > 0
    backBtn.hidden = step === 1
    if (step === 1) {
      nextBtn.hidden = !hasContent
      nextBtn.textContent = 'Continue'
      nextBtn.className = 'wiz-primary'
      nextBtn.onclick = () => go(2)
    } else if (step < STEP_TITLES.length) {
      nextBtn.hidden = false
      const skip = (step === 3 && !project.places.some(p => p.visible)) || (step === 4 && !project.photos.length)
      nextBtn.textContent = skip ? 'Skip' : 'Continue'
      nextBtn.className = skip ? 'wiz-ghost' : 'wiz-primary'
      nextBtn.onclick = () => go(step + 1)
    } else {
      nextBtn.hidden = true
    }
    foot.hidden = backBtn.hidden && nextBtn.hidden
  }

  function render() {
    if (!isOpen()) return
    renderContent()
  }

  function reset() {
    step = 1
    activeDayId = ''
    showAddPlace = false
    photoDayId = ''
    expandedCropPhotoId = ''
    statusText = ''
  }

  return { show, hide, render, reset, isOpen }
}
