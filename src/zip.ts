type ZipEntry = { name: string, bytes: Uint8Array }

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let i = 0; i < 8; i++) {
    byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0)
  }
  return byte
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A ZIP32 archive with stored image bytes and UTF-8 filenames. */
export function zip(entries: ZipEntry[]): Blob {
  const limit = 0xffffffff
  const encoder = new TextEncoder()
  const names = new Set<string>()
  let directoryStart = 0
  let directorySize = 0
  if (entries.length >= 0xffff) throw new Error('Select fewer posters for this ZIP.')
  const files = entries.map(entry => {
    if (!entry.name || /[\/\\\x00-\x1f]/.test(entry.name) || entry.name === '.' || entry.name === '..')
      throw new Error('Each poster needs a valid filename.')
    if (names.has(entry.name)) throw new Error('Each poster needs a unique filename.')
    names.add(entry.name)
    const name = encoder.encode(entry.name)
    if (name.length > 0xffff) throw new Error('A poster filename is too long.')
    const offset = directoryStart
    directoryStart += 30 + name.length + entry.bytes.length
    directorySize += 46 + name.length
    return { bytes: entry.bytes, name, offset }
  })
  const totalSize = directoryStart + directorySize + 22
  if (totalSize >= limit) throw new Error('The selected posters exceed the ZIP size limit.')

  const buffer = new ArrayBuffer(totalSize)
  const data = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let cursor = 0
  function word(value: number) { view.setUint16(cursor, value, true); cursor += 2 }
  function dword(value: number) { view.setUint32(cursor, value, true); cursor += 4 }
  function write(bytes: Uint8Array) { data.set(bytes, cursor); cursor += bytes.length }
  function fileHeader(size: number, checksum: number, nameLength: number) {
    word(20)        // minimum ZIP version
    word(1 << 11)   // UTF-8 filename
    word(0)         // stored (JPG and PNG are already compressed)
    word(0)         // DOS time
    word(0x21)      // 1980-01-01, the first representable ZIP date
    dword(checksum)
    dword(size)
    dword(size)
    word(nameLength)
    word(0)         // no extra fields
  }
  let directoryOffset = directoryStart
  for (const file of files) {
    const checksum = crc32(file.bytes)
    cursor = file.offset
    dword(0x04034b50)
    fileHeader(file.bytes.length, checksum, file.name.length)
    write(file.name)
    write(file.bytes)

    cursor = directoryOffset
    dword(0x02014b50)
    word(20)        // writer version
    fileHeader(file.bytes.length, checksum, file.name.length)
    word(0)         // comment length
    word(0)         // start disk
    word(0)         // internal attributes
    dword(0)        // external attributes
    dword(file.offset)
    write(file.name)
    directoryOffset = cursor
  }
  cursor = directoryOffset
  dword(0x06054b50)
  word(0)
  word(0)
  word(files.length)
  word(files.length)
  dword(directorySize)
  dword(directoryStart)
  word(0)
  return new Blob([buffer], { type: 'application/zip' })
}
