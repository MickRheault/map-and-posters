import {
  applyAiSplitPlan,
  buildAiSplitPlan,
  clearAiConfig,
  collectRouteSamples,
  DEFAULT_MODELS,
  loadAiConfig,
  saveAiConfig,
  selectPlanPass,
  type AiProvider,
  type AiSplitPlan,
} from './ai-split'
import { addPlace, readCoordinates, readPhoto, type Photo, type Place } from './assets'
import { visitCandidates } from './assets-ui'
import { MAX_MAP_ZOOM, clampMapView, clientToMapPoint, combinedRanges, dayName, insertRestDay, moveRecording, panMapView, pickBoundaryPasses, possibleOverlap, setBoundary, zoomMapView, type Day, type MapView, type PointRef } from './itinerary'
import { downloadBlob, posterFiles, rasterize, slug, wireLabelEditing, zipFiles } from './output'
import {
  getGooglePlacesKey,
  resolvePlace,
  searchPlaces,
  setGooglePlacesKey,
  snapPlaceToRoute,
  trackBounds,
  type GeoBounds,
  type PlaceResult,
} from './places-search'
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

type Sample = PointRef & { lat: number, lon: number, x: number, y: number, km: number, run: number }

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
  let showStep2Search = false
  let photoDayId = ''
  let expandedCropPhotoId = ''
  let statusText = ''
  let busy = false
  let searchCleanups: (() => void)[] = []
  let aiOpen = false
  let aiSettingsOpen: boolean | null = null
  let aiPrompt = ''
  let aiBusy = false
  let aiError = ''
  let aiPlan: AiSplitPlan | null = null

  function cancelSearches() {
    for (const stop of searchCleanups) stop()
    searchCleanups = []
  }

  function wirePlaceAutocomplete(options: {
    input: HTMLInputElement
    list: HTMLUListElement
    bounds: GeoBounds | null
    searchOnEnter?: boolean
    onSelect: (place: PlaceResult) => void
    onError: (message: string) => void
    onEmpty?: () => void
    onClear?: () => void
  }) {
    const { input, list, bounds, searchOnEnter, onSelect, onError, onEmpty, onClear } = options
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let sessionToken = crypto.randomUUID()

    function clearList() {
      list.replaceChildren()
      list.hidden = true
    }

    function stop() {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (controller) { controller.abort(); controller = undefined }
    }
    searchCleanups.push(stop)

    async function runSearch(raw: string) {
      stop()
      const q = raw.trim()
      if (q.length < 2) {
        clearList()
        onClear?.()
        return
      }
      const current = new AbortController()
      controller = current
      const outcome = await searchPlaces(q, {
        bounds,
        sessionToken,
        signal: current.signal,
      })
      if (outcome.aborted || controller !== current || !input.isConnected || !list.isConnected) return
      if (outcome.error) {
        clearList()
        onError(outcome.error)
        return
      }
      if (!outcome.suggestions.length) {
        clearList()
        onEmpty?.()
        return
      }
      onClear?.()
      list.replaceChildren(...outcome.suggestions.map(suggestion => {
        const item = el('li')
        const pick = el('button', '', 'wiz-suggestion')
        pick.type = 'button'
        pick.append(el('strong', suggestion.name))
        if (suggestion.subtitle) pick.append(el('span', suggestion.subtitle))
        pick.onclick = async () => {
          pick.disabled = true
          const resolved = await resolvePlace(suggestion, { sessionToken, signal: current.signal })
          if (resolved.aborted || !input.isConnected) return
          if (resolved.error || !resolved.place) {
            pick.disabled = false
            onError(resolved.error || 'Could not load coordinates for this place.')
            return
          }
          sessionToken = crypto.randomUUID()
          clearList()
          onSelect(resolved.place)
        }
        item.append(pick)
        return item
      }))
      list.hidden = false
    }

    input.addEventListener('input', () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (input.value.trim().length < 2) {
        stop()
        clearList()
        onClear?.()
        return
      }
      timer = setTimeout(() => { void runSearch(input.value) }, 180)
    })

    input.addEventListener('keydown', e => {
      if (e.isComposing) return
      if (e.key === 'ArrowDown' && !list.hidden) {
        e.preventDefault()
        list.querySelector<HTMLButtonElement>('button')?.focus()
      } else if (e.key === 'Escape' && !list.hidden) {
        e.preventDefault()
        e.stopPropagation()
        clearList()
      } else if (e.key === 'Enter' && searchOnEnter) {
        e.preventDefault()
        void runSearch(input.value)
      }
    })

    list.addEventListener('keydown', e => {
      const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button'))
      const idx = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'ArrowDown' && buttons.length) {
        e.preventDefault()
        buttons[(idx + 1) % buttons.length].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (idx <= 0) input.focus()
        else buttons[idx - 1].focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        clearList()
        input.focus()
      }
    })

    return { clearList, stop }
  }

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
    cancelSearches()
    if (typeof dialog.close === 'function') dialog.close('exit')
    else {
      dialog.removeAttribute('open')
      hooks.onExit()
    }
  }

  dialog.addEventListener('close', () => {
    cancelSearches()
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

  function renderAiSplitBox(project: Project): HTMLElement | null {
    if (collectRouteSamples(project).samples.length < 3) return null

    const config = loadAiConfig()
    const detailsEl = el('details', '', 'wiz-ai')
    detailsEl.open = aiOpen
    detailsEl.addEventListener('toggle', () => {
      if (!detailsEl.isConnected) return
      aiOpen = detailsEl.open
    })

    const summary = el('summary', 'Ask AI to split days', 'wiz-ai-trigger')
    detailsEl.append(summary)

    const panel = el('div', '', 'wiz-ai-panel')

    const promptField = el('div', '', 'wiz-ai-field')
    const promptLabel = el('label', 'Describe your days')
    promptLabel.htmlFor = 'wiz-ai-prompt'
    const hint = el('p', 'Stop names are geocoded onto your GPX track. Nothing changes until you click Apply plan.', 'wiz-ai-hint')
    hint.id = 'wiz-ai-hint'
    const promptInput = el('textarea', '', 'wiz-input wiz-ai-prompt')
    promptInput.id = 'wiz-ai-prompt'
    promptInput.rows = 2
    promptInput.placeholder = 'e.g. Day 1 finished in Pai, Day 2 was a rest day in Pai'
    promptInput.setAttribute('aria-describedby', 'wiz-ai-hint')
    promptInput.value = aiPrompt
    promptInput.disabled = aiBusy
    promptInput.oninput = () => { aiPrompt = promptInput.value }
    promptField.append(promptLabel, hint, promptInput)
    panel.append(promptField)

    const settingsEl = el('details', '', 'wiz-ai-settings')
    const needsSetup = !config.apiKey && !config.endpoint
    settingsEl.open = aiSettingsOpen ?? needsSetup
    settingsEl.addEventListener('toggle', () => {
      if (!settingsEl.isConnected) return
      aiSettingsOpen = settingsEl.open
    })
    settingsEl.append(el('summary', 'AI & geocoding settings'))

    const grid = el('div', '', 'wiz-ai-settings-grid')

    const providerField = el('div', '', 'wiz-ai-field')
    const providerLabel = el('label', 'Provider')
    providerLabel.htmlFor = 'wiz-ai-provider'
    const providerSel = el('select', '', 'wiz-select-sm')
    providerSel.id = 'wiz-ai-provider'
    providerSel.disabled = aiBusy
    for (const [val, labelText] of [['openai', 'OpenAI-compatible'], ['gemini', 'Gemini']] as const) {
      const opt = el('option', labelText)
      opt.value = val
      if (config.provider === val) opt.selected = true
      providerSel.add(opt)
    }
    providerField.append(providerLabel, providerSel)

    const modelField = el('div', '', 'wiz-ai-field')
    const modelLabel = el('label', 'Model')
    modelLabel.htmlFor = 'wiz-ai-model'
    const modelInput = el('input', '', 'wiz-input')
    modelInput.id = 'wiz-ai-model'
    modelInput.type = 'text'
    modelInput.value = config.model
    modelInput.disabled = aiBusy
    modelField.append(modelLabel, modelInput)

    const keyField = el('div', '', 'wiz-ai-field wiz-ai-span')
    const keyLabel = el('label', 'API key')
    keyLabel.htmlFor = 'wiz-ai-key'
    const keyInput = el('input', '', 'wiz-input')
    keyInput.id = 'wiz-ai-key'
    keyInput.type = 'password'
    keyInput.autocomplete = 'off'
    keyInput.placeholder = 'Stored only in this browser'
    keyInput.value = config.apiKey
    keyInput.disabled = aiBusy
    keyField.append(keyLabel, keyInput)

    const endpointField = el('div', '', 'wiz-ai-field wiz-ai-span')
    const endpointLabel = el('label', 'Custom endpoint (optional)')
    endpointLabel.htmlFor = 'wiz-ai-endpoint'
    const endpointInput = el('input', '', 'wiz-input')
    endpointInput.id = 'wiz-ai-endpoint'
    endpointInput.type = 'url'
    endpointInput.placeholder = 'Blank for provider default, or https://… / http://localhost:…'
    endpointInput.value = config.endpoint
    endpointInput.disabled = aiBusy
    endpointField.append(endpointLabel, endpointInput)

    const placesField = el('div', '', 'wiz-ai-field wiz-ai-span')
    const placesLabel = el('label', 'Google Places key (optional)')
    placesLabel.htmlFor = 'wiz-ai-places-key'
    const placesInput = el('input', '', 'wiz-input')
    placesInput.id = 'wiz-ai-places-key'
    placesInput.type = 'password'
    placesInput.autocomplete = 'off'
    placesInput.placeholder = 'Optional — uses free OSM Photon if blank'
    placesInput.value = config.googlePlacesKey
    placesInput.disabled = aiBusy
    placesField.append(placesLabel, placesInput)

    const persistConfig = () => {
      const nextProvider: AiProvider = providerSel.value === 'gemini' ? 'gemini' : 'openai'
      return saveAiConfig({
        provider: nextProvider,
        model: modelInput.value,
        apiKey: keyInput.value,
        endpoint: endpointInput.value,
        googlePlacesKey: placesInput.value,
      })
    }

    providerSel.onchange = () => {
      const prevDefault = DEFAULT_MODELS[config.provider]
      const nextProvider: AiProvider = providerSel.value === 'gemini' ? 'gemini' : 'openai'
      if (!modelInput.value.trim() || modelInput.value.trim() === prevDefault) {
        modelInput.value = DEFAULT_MODELS[nextProvider]
      }
      try {
        persistConfig()
        aiError = ''
      } catch (e) {
        aiError = (e as Error).message
      }
      render()
    }
    for (const inputEl of [modelInput, keyInput, endpointInput, placesInput]) {
      inputEl.onchange = () => {
        try {
          persistConfig()
          aiError = ''
        } catch (e) {
          aiError = (e as Error).message
          render()
        }
      }
    }

    grid.append(providerField, modelField, keyField, endpointField, placesField)
    const settingsFoot = el('div', '', 'wiz-ai-settings-foot')
    settingsFoot.append(
      el('span', 'Keys stay in localStorage and are never saved in trip backups.', 'wiz-ai-hint'),
      btn('Clear keys', () => {
        clearAiConfig()
        aiError = ''
        aiSettingsOpen = true
        render()
      }, 'wiz-link wiz-danger'),
    )
    settingsEl.append(grid, settingsFoot)
    panel.append(settingsEl)

    const actions = el('div', '', 'wiz-ai-actions')
    const suggestBtn = btn(aiBusy ? 'Planning split…' : 'Suggest split plan', async () => {
      aiPrompt = promptInput.value
      let savedConfig
      try {
        savedConfig = persistConfig()
      } catch (e) {
        aiError = (e as Error).message
        render()
        return
      }
      aiBusy = true
      aiError = ''
      aiOpen = true
      render()
      try {
        const plan = await buildAiSplitPlan(aiPrompt, project, savedConfig)
        aiPlan = plan
        aiSettingsOpen = false
      } catch (e) {
        aiPlan = null
        aiError = e instanceof Error ? e.message : 'Could not build an AI split plan.'
      } finally {
        aiBusy = false
        render()
        const focusTarget = dialog.querySelector<HTMLElement>('.wiz-ai-pass-select')
          || dialog.querySelector<HTMLElement>('#wiz-ai-apply')
        if (aiPlan && focusTarget && !focusTarget.hasAttribute('disabled')) focusTarget.focus()
      }
    }, 'wiz-ghost')
    suggestBtn.id = 'wiz-ai-generate'
    suggestBtn.disabled = aiBusy
    actions.append(suggestBtn)
    panel.append(actions)

    if (aiError) {
      const errEl = el('p', aiError, 'wiz-ai-error')
      errEl.id = 'wiz-ai-error'
      errEl.setAttribute('role', 'alert')
      panel.append(errEl)
    }

    if (aiPlan) {
      const plan = aiPlan
      const review = el('div', '', 'wiz-ai-review')
      const head = el('div', '', 'wiz-ai-review-head')
      head.append(el('strong', 'Proposed split plan'), el('span', plan.totalKm.toFixed(1) + ' km total', 'wiz-meta'))
      review.append(head)

      if (plan.errors.length) {
        const errBox = el('div', '', 'wiz-ai-error')
        errBox.setAttribute('role', 'alert')
        for (const msg of plan.errors) errBox.append(el('p', msg))
        review.append(errBox)
      }

      const list = el('ol', '', 'wiz-ai-plan')
      list.setAttribute('role', 'list')
      plan.days.forEach((pd, idx) => {
        const item = el('li', '', 'wiz-ai-day')
        const main = el('div', '', 'wiz-ai-day-main')
        const title = 'Day ' + pd.dayIndex + (pd.kind === 'rest' ? ' · Rest day' : '') + (pd.name && pd.name !== 'Rest day' ? ' · ' + pd.name : '')
        main.append(el('strong', title))

        const detailsParts: string[] = []
        if (pd.kind === 'ride') {
          detailsParts.push(pd.km.toFixed(1) + ' km')
          if (pd.split?.resolved) {
            const chosen = pd.split.candidates[pd.split.selectedPassIndex]
            const distNote = chosen ? ' (' + chosen.distanceKm.toFixed(1) + ' km from track)' : ''
            detailsParts.push('Ends at ' + pd.split.resolved.name + distNote)
          } else if (pd.inferredRemainder) {
            detailsParts.push('Remainder of route')
          } else if (pd.split?.error) {
            detailsParts.push(pd.split.error)
          }
        }
        if (detailsParts.length) main.append(el('span', detailsParts.join(' · '), 'wiz-meta'))
        if (pd.overnight?.resolved) {
          main.append(el('span', 'Overnight: ' + pd.overnight.resolved.name, 'wiz-ai-badge'))
        } else if (pd.overnight?.error) {
          main.append(el('span', pd.overnight.error, 'wiz-warn'))
        }
        item.append(main)

        if (pd.split?.ambiguous && pd.split.candidates.length > 1) {
          const passRow = el('div', '', 'wiz-ai-pass-row')
          const placeLabel = pd.split.resolved?.name || pd.split.query
          passRow.append(el('span', 'Passed ' + pd.split.candidates.length + ' times', 'wiz-warn'))
          const selectId = 'wiz-ai-pass-' + idx
          const lbl = el('label', 'Confirm pass for ' + placeLabel)
          lbl.htmlFor = selectId
          const sel = el('select', '', 'wiz-select-sm wiz-ai-pass-select')
          sel.id = selectId
          pd.split.candidates.forEach((cand, cIdx) => {
            const opt = el('option', 'Pass ' + (cIdx + 1) + ' · ' + cand.trackKm.toFixed(1) + ' km')
            opt.value = String(cIdx)
            if (cIdx === pd.split!.selectedPassIndex) opt.selected = true
            sel.add(opt)
          })
          sel.onchange = () => {
            aiPlan = selectPlanPass(plan, pd.id, Number(sel.value))
            render()
          }
          passRow.append(lbl, sel)
          item.append(passRow)
        }

        list.append(item)
      })
      review.append(list)

      const reviewActions = el('div', '', 'wiz-ai-review-actions')
      const applyBtn = btn('Apply plan', () => {
        try {
          applyAiSplitPlan(project, plan)
          activeDayId = project.days[0]?.id || ''
          aiPlan = null
          aiError = ''
          aiOpen = false
          setStatus('Applied AI split plan (' + project.days.length + ' days).')
          mutate()
        } catch (e) {
          aiError = e instanceof Error ? e.message : 'Could not apply split plan.'
          render()
        }
      }, 'wiz-primary')
      applyBtn.id = 'wiz-ai-apply'
      applyBtn.disabled = !plan.canApply
      const discardBtn = btn('Discard', () => {
        aiPlan = null
        aiError = ''
        render()
      }, 'wiz-link')
      discardBtn.id = 'wiz-ai-discard'
      reviewActions.append(applyBtn, discardBtn)
      review.append(reviewActions)
      panel.append(review)
    }

    detailsEl.append(panel)
    return detailsEl
  }

  function renderStep2(project: Project) {
    if (!project.days.length) {
      content.append(btn('+ Rest day', () => {
        const rest = insertRestDay(project, 0)
        activeDayId = rest.id
        aiPlan = null
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
      aiPlan = null
      mutate()
    }, 'wiz-pill-add'))
    content.append(pills)

    const deleteBtn = () => btn('Delete day', () => {
      hooks.deleteDay(day.id)
      const next = project.days[Math.min(index, project.days.length - 1)]
      activeDayId = next?.id || ''
      aiPlan = null
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
      const aiBox = renderAiSplitBox(project)
      if (aiBox) content.append(aiBox)
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
      const raw = segments[run]
      line.forEach((p, i) => samples.push({
        recordingId: r.recordingId, segment: r.segment, point: r.start + i, run, km: p.km,
        lat: raw[i].lat, lon: raw[i].lon,
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
      const aiBox = renderAiSplitBox(project)
      if (aiBox) content.append(aiBox)
      return
    }

    const mapWrap = el('div', '', 'wiz-map-wrap')
    const map = svgEl('svg', { viewBox: '0 0 400 200', class: 'wiz-split-map', role: 'img', 'aria-label': 'Choose a boundary on the recorded route' })
    const zoomControls = el('div', '', 'wiz-map-controls')
    zoomControls.setAttribute('role', 'group')
    zoomControls.setAttribute('aria-label', 'Map zoom')
    let view: MapView = { zoom: 1, x: 0, y: 0 }
    const fmt = (n: number) => String(Number(n.toFixed(2)))
    const zoomOutBtn = btn('-', () => {
      const anchor = { x: view.x + 200 / view.zoom, y: view.y + 100 / view.zoom }
      view = zoomMapView(view, view.zoom / 2, anchor)
      applyView()
    }, 'wiz-map-btn')
    zoomOutBtn.setAttribute('aria-label', 'Zoom out')
    const zoomInBtn = btn('+', () => {
      const anchor = { x: view.x + 200 / view.zoom, y: view.y + 100 / view.zoom }
      view = zoomMapView(view, view.zoom * 2, anchor)
      applyView()
    }, 'wiz-map-btn')
    zoomInBtn.setAttribute('aria-label', 'Zoom in')
    const resetZoomBtn = btn('Reset', () => {
      view = { zoom: 1, x: 0, y: 0 }
      applyView()
    }, 'wiz-map-btn wiz-map-reset')
    zoomControls.append(zoomOutBtn, zoomInBtn, resetZoomBtn)
    mapWrap.append(map, zoomControls)

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

    function applyView() {
      const vw = 400 / view.zoom
      const vh = 200 / view.zoom
      map.setAttribute('viewBox', `${fmt(view.x)} ${fmt(view.y)} ${fmt(vw)} ${fmt(vh)}`)
      map.classList.toggle('is-zoomed', view.zoom > 1)
      zoomOutBtn.disabled = view.zoom <= 1
      resetZoomBtn.disabled = view.zoom <= 1
      zoomInBtn.disabled = view.zoom >= MAX_MAP_ZOOM
      const strokeWidth = (3.5 / view.zoom).toFixed(2)
      for (const path of map.querySelectorAll('path')) path.setAttribute('stroke-width', strokeWidth)
      const marker = map.querySelector('circle')
      if (marker) {
        marker.setAttribute('r', (5.5 / view.zoom).toFixed(2))
        marker.setAttribute('stroke-width', (2.5 / view.zoom).toFixed(2))
      }
    }

    function draw() {
      slider.value = String(split)
      const chosen = samples[split]
      readout.textContent = chosen.km.toFixed(1) + ' km  ·  ' + (bounds.km - chosen.km).toFixed(1) + ' km'
      map.replaceChildren()
      let path = '', prevColor = '', prevRun = -1
      const strokeWidth = (3.5 / view.zoom).toFixed(2)
      const flush = () => {
        if (path) map.prepend(svgEl('path', { fill: 'none', stroke: prevColor, 'stroke-width': strokeWidth, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', d: path }))
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
      map.append(svgEl('circle', {
        cx: String(chosen.x),
        cy: String(chosen.y),
        r: (5.5 / view.zoom).toFixed(2),
        fill: '#fff',
        stroke: '#173b33',
        'stroke-width': (2.5 / view.zoom).toFixed(2),
      }))
      applyView()
    }

    const setSplit = (v: number) => { split = Math.max(1, Math.min(samples.length - 2, v)); draw() }
    function focusSplitOnMap() {
      if (view.zoom <= 1) return
      const chosen = samples[split]
      const vw = 400 / view.zoom
      const vh = 200 / view.zoom
      view = clampMapView({ zoom: view.zoom, x: chosen.x - vw / 2, y: chosen.y - vh / 2 })
      applyView()
    }
    function applyCandidates(candidates: number[]) {
      if (!candidates.length) return
      passes.replaceChildren(...candidates.map((idx, n) => {
        const o = el('option', 'Pass ' + (n + 1) + ' · ' + samples[idx].km.toFixed(1) + ' km')
        o.value = String(idx)
        return o
      }))
      passes.hidden = candidates.length < 2
      setSplit(candidates[0])
    }

    slider.oninput = () => { passes.hidden = true; setSplit(Number(slider.value)) }

    map.addEventListener('wheel', ev => {
      ev.preventDefault()
      const rect = map.getBoundingClientRect()
      const anchor = clientToMapPoint(rect, view, ev.clientX, ev.clientY)
      const factor = ev.deltaY < 0 ? 1.5 : 1 / 1.5
      view = zoomMapView(view, view.zoom * factor, anchor)
      applyView()
    }, { passive: false })

    const DRAG_THRESHOLD_PX = 5
    let drag: { pointerId: number, startClientX: number, startClientY: number, startView: MapView, moved: boolean } | null = null
    let suppressClickAt: { x: number, y: number } | null = null

    map.addEventListener('pointerdown', ev => {
      suppressClickAt = null
      if (ev.button !== 0 || view.zoom <= 1) return
      const pointerId = ev.pointerId ?? 0
      drag = { pointerId, startClientX: ev.clientX, startClientY: ev.clientY, startView: { ...view }, moved: false }
      if (typeof map.setPointerCapture === 'function' && ev.pointerId !== undefined) map.setPointerCapture(ev.pointerId)
    })
    map.addEventListener('pointermove', ev => {
      if (!drag || (ev.pointerId ?? 0) !== drag.pointerId) return
      const dxPx = ev.clientX - drag.startClientX
      const dyPx = ev.clientY - drag.startClientY
      if (!drag.moved && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      map.classList.add('is-panning')
      view = panMapView(drag.startView, dxPx, dyPx, map.getBoundingClientRect())
      applyView()
    })
    const endPan = (ev: PointerEvent) => {
      if (!drag || (ev.pointerId ?? 0) !== drag.pointerId) return
      if (drag.moved) suppressClickAt = { x: ev.clientX, y: ev.clientY }
      if (typeof map.releasePointerCapture === 'function' && ev.pointerId !== undefined && map.hasPointerCapture?.(ev.pointerId)) {
        map.releasePointerCapture(ev.pointerId)
      }
      map.classList.remove('is-panning')
      drag = null
    }
    map.addEventListener('pointerup', endPan)
    map.addEventListener('pointercancel', endPan)

    map.onclick = ev => {
      if (suppressClickAt) {
        const suppressed = suppressClickAt
        suppressClickAt = null
        if (Math.hypot(ev.clientX - suppressed.x, ev.clientY - suppressed.y) < DRAG_THRESHOLD_PX) return
      }
      const rect = map.getBoundingClientRect()
      const loc = clientToMapPoint(rect, view, ev.clientX, ev.clientY)
      const candidates = pickBoundaryPasses(samples, loc, { zoom: view.zoom })
      applyCandidates(candidates)
    }
    passes.onchange = () => { setSplit(Number(passes.value)); focusSplitOnMap() }

    const findBox = document.createElement('search')
    findBox.id = 'wiz-step2-search'
    findBox.className = 'wiz-find-box'
    findBox.hidden = !showStep2Search
    const findRow = el('div', '', 'wiz-find-row')
    const findInput = el('input', '', 'wiz-input')
    findInput.type = 'search'
    findInput.placeholder = 'Search city or stop (e.g. Pai)'
    findInput.setAttribute('aria-label', 'Find place on route')
    findInput.enterKeyHint = 'search'
    const findList = el('ul', '', 'wiz-suggestions')
    findList.id = 'wiz-step2-suggestions'
    findList.setAttribute('role', 'list')
    findList.setAttribute('aria-label', 'Route place suggestions')
    findList.hidden = true

    const findToggle = btn('Find place', () => {
      showStep2Search = !showStep2Search
      findBox.hidden = !showStep2Search
      findToggle.setAttribute('aria-expanded', String(showStep2Search))
      if (showStep2Search) findInput.focus()
      else findToggle.focus()
    }, 'wiz-link')
    findToggle.setAttribute('aria-expanded', String(showStep2Search))
    findToggle.setAttribute('aria-controls', 'wiz-step2-search')

    const closeFind = btn('Close', () => {
      showStep2Search = false
      findBox.hidden = true
      findToggle.setAttribute('aria-expanded', 'false')
      findToggle.focus()
    }, 'wiz-link')
    findInput.addEventListener('keydown', e => {
      if (e.key === 'Escape' && findList.hidden && showStep2Search) {
        e.preventDefault()
        e.stopPropagation()
        closeFind.click()
      }
    })
    findRow.append(findInput, closeFind)
    findBox.append(findRow, findList)

    wirePlaceAutocomplete({
      input: findInput,
      list: findList,
      bounds: trackBounds([segments]),
      searchOnEnter: true,
      onSelect: place => {
        findInput.value = place.name
        const hits = snapPlaceToRoute(samples, place.coords)
        if (!hits.length) {
          setStatus('Could not snap ' + place.name + ' to this day’s route.')
          return
        }
        applyCandidates(hits.map(h => h.index))
        focusSplitOnMap()
        const nearest = hits[0].distanceKm
        const distNote = nearest < 0.1 ? 'on route' : nearest.toFixed(1) + ' km from route'
        if (hits.length >= 2) {
          setStatus(`Found ${hits.length} passes near ${place.name} (${distNote}). Pick a pass and choose Split here.`)
          passes.focus()
        } else {
          setStatus(`Moved split to ${place.name} (${distNote}). Choose Split here to confirm.`)
        }
      },
      onError: msg => setStatus(msg),
      onEmpty: () => setStatus('No matching places found.'),
      onClear: () => setStatus(''),
    })

    const bar = el('div', '', 'wiz-split-bar')
    const barLeft = el('div', '', 'wiz-split-left')
    barLeft.append(readout, findToggle)
    const barActions = el('div', '', 'wiz-stop-actions')
    barActions.append(deleteBtn(), btn('Split here', () => {
      try {
        const nextDay = setBoundary(project, day, null, samples[split])
        activeDayId = nextDay.id
        showStep2Search = false
        aiPlan = null
        setStatus('')
        mutate()
      } catch (e) { setStatus((e as Error).message) }
    }, 'wiz-ghost'))
    bar.append(barLeft, barActions)

    draw()
    content.append(findBox, mapWrap, passes, slider, bar)
    const aiBox = renderAiSplitBox(project)
    if (aiBox) content.append(aiBox)
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
    const panel = el('div', '', 'wiz-add-panel')
    const form = el('div', '', 'wiz-add-row')
    const nameIn = el('input', '', 'wiz-input')
    nameIn.type = 'text'
    nameIn.placeholder = 'Place name'
    nameIn.setAttribute('aria-label', 'Place name')
    const locIn = el('input', '', 'wiz-input')
    locIn.type = 'text'
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

    const suggestions = el('ul', '', 'wiz-suggestions')
    suggestions.id = 'wiz-stop-suggestions'
    suggestions.setAttribute('role', 'list')
    suggestions.setAttribute('aria-label', 'Place suggestions')
    suggestions.hidden = true

    const includedTracks = project.recordings.filter(r => r.included).map(r => r.track)
    wirePlaceAutocomplete({
      input: nameIn,
      list: suggestions,
      bounds: trackBounds(includedTracks),
      onSelect: place => {
        nameIn.value = place.name
        locIn.value = `${place.coords.lat.toFixed(6)}, ${place.coords.lon.toFixed(6)}`
        setStatus(`Selected ${place.name}. Choose Add to save.`)
        add.focus()
      },
      onError: msg => setStatus(msg),
      onClear: () => setStatus(''),
    })

    const keyBar = el('div', '', 'wiz-key-bar')
    const providerNote = el('span')
    const keyPanel = el('div', '', 'wiz-key-panel')
    keyPanel.id = 'wiz-places-key-panel'
    keyPanel.hidden = true

    const keyLabel = el('label', 'Google Places API key', 'wiz-key-label')
    keyLabel.htmlFor = 'wiz-google-key'
    const keyRow = el('div', '', 'wiz-key-row')
    const keyInput = el('input', '', 'wiz-input')
    keyInput.id = 'wiz-google-key'
    keyInput.type = 'password'
    keyInput.placeholder = 'Paste Google Places key'
    keyInput.autocomplete = 'off'
    keyInput.spellcheck = false
    keyInput.setAttribute('aria-describedby', 'wiz-google-key-note')
    const keyNote = el('small', 'Stored only in this browser (never in trip backups). Leave blank to use free OpenStreetMap search.', 'wiz-key-note')
    keyNote.id = 'wiz-google-key-note'

    const keyToggle = btn('', () => {
      keyPanel.hidden = !keyPanel.hidden
      keyToggle.setAttribute('aria-expanded', String(!keyPanel.hidden))
      if (!keyPanel.hidden) {
        keyInput.value = getGooglePlacesKey()
        keyInput.focus()
      }
    }, 'wiz-link')
    keyToggle.setAttribute('aria-expanded', 'false')
    keyToggle.setAttribute('aria-controls', 'wiz-places-key-panel')

    const clearKeyBtn = btn('Clear', () => {
      setGooglePlacesKey('')
      keyInput.value = ''
      keyPanel.hidden = true
      keyToggle.setAttribute('aria-expanded', 'false')
      syncKeyUi()
      setStatus('Cleared Google Places key — using OpenStreetMap search.')
      keyToggle.focus()
    }, 'wiz-link')

    const saveKeyBtn = btn('Save key', () => {
      const saved = setGooglePlacesKey(keyInput.value)
      keyPanel.hidden = true
      keyToggle.setAttribute('aria-expanded', 'false')
      syncKeyUi()
      setStatus(saved
        ? 'Google Places key saved in this browser only.'
        : 'Cleared Google Places key — using OpenStreetMap search.')
      keyToggle.focus()
    }, 'wiz-ghost')

    keyInput.addEventListener('keydown', e => {
      if (e.isComposing) return
      if (e.key === 'Enter') {
        e.preventDefault()
        saveKeyBtn.click()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        keyPanel.hidden = true
        keyToggle.setAttribute('aria-expanded', 'false')
        keyToggle.focus()
      }
    })

    function syncKeyUi() {
      const active = Boolean(getGooglePlacesKey())
      providerNote.textContent = active ? 'Search: Google Places (this browser)' : 'Search: OpenStreetMap (free)'
      keyToggle.textContent = active ? 'Google key · active' : 'Google key'
      clearKeyBtn.hidden = !active
    }
    syncKeyUi()

    keyRow.append(keyInput, saveKeyBtn, clearKeyBtn)
    keyPanel.append(keyLabel, keyRow, keyNote)
    keyBar.append(providerNote, keyToggle)
    panel.append(form, suggestions, keyBar, keyPanel)
    content.append(panel)
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
    cancelSearches()
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
    cancelSearches()
    step = 1
    activeDayId = ''
    showAddPlace = false
    showStep2Search = false
    photoDayId = ''
    expandedCropPhotoId = ''
    statusText = ''
    aiOpen = false
    aiSettingsOpen = null
    aiPrompt = ''
    aiBusy = false
    aiError = ''
    aiPlan = null
  }

  return { show, hide, render, reset, isOpen }
}
