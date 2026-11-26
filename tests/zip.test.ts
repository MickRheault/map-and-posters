import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zip } from '../src/zip'

test('ZIP preserves file order, UTF-8 names and bytes and passes independent CRC validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'map-posters-zip-'))
  try {
    const bytes = Uint8Array.from([0, 1, 2, 255])
    const name = 'วันที่ 2 · Pai.png'
    const archive = zip([{ name: 'Overview.jpg', bytes: new Uint8Array() }, { name, bytes }])
    const file = join(dir, 'posters.zip')
    writeFileSync(file, Buffer.from(await archive.arrayBuffer()))
    const inspect = 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps([z.testzip(),z.namelist(),list(z.read(z.namelist()[1]))]))'
    const report = JSON.parse(execFileSync('python3',['-c',inspect,file],{ encoding:'utf8' }))
    expect(archive.type).toBe('application/zip')
    expect(report).toEqual([null,['Overview.jpg',name],Array.from(bytes)])
  } finally {
    rmSync(dir,{ recursive:true,force:true })
  }
})

test('ZIP rejects duplicate and nested filenames', () => {
  const file={ name:'day.jpg',bytes:new Uint8Array() }
  expect(()=>zip([file,file])).toThrow(/unique/)
  expect(()=>zip([{...file,name:'../trip.jpg'}])).toThrow(/valid filename/)
})
