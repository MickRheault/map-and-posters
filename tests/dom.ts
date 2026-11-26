import { JSDOM } from 'jsdom'

const { window } = new JSDOM('', { url: 'https://trip.test' })
for (const name of ['DOMParser', 'document', 'XMLSerializer', 'HTMLElement', 'SVGElement', 'Event', 'MouseEvent', 'HTMLInputElement', 'HTMLSelectElement'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: window[name] })
}
