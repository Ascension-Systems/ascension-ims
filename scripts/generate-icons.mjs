#!/usr/bin/env node
/**
 * Deterministic achromatic PWA icons.  `npm run icons:generate`
 *
 * Emits a black rounded square containing three white horizontal bars of differing lengths --
 * an abstract list mark.
 *
 * IT MUST NOT READ AS A LOGO OR WORDMARK, CONTAIN LETTERS, OR CONTAIN COLOUR (D2). There is
 * no invented brand here, for Kyrie, for Ascension or for the end client.
 *
 * No image dependencies: PNGs are encoded by hand from raw RGBA scanlines using node's
 * built-in zlib. Deterministic by construction -- no randomness, no timestamps -- so
 * regenerating produces byte-identical files.
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(HERE, '..', 'public')

/* ------------------------------------------------------------------ *
 * Minimal PNG encoder
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** @param {Uint8Array} rgba length = size * size * 4 */
function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    )
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ *
 * The mark
 * ------------------------------------------------------------------ */

const BLACK = [0x00, 0x00, 0x00, 0xff]
const WHITE = [0xff, 0xff, 0xff, 0xff]
const TRANSPARENT = [0x00, 0x00, 0x00, 0x00]

/**
 * @param size    pixel dimension
 * @param inset   fraction of the canvas left clear around the rounded square.
 *                Maskable icons need their content inside the safe zone (the centre 80%),
 *                so they get a larger inset and a full-bleed black ground.
 * @param bleed   when true, the whole canvas is black and the rounded square is implied by
 *                the padding rather than drawn (correct for `purpose: maskable`).
 */
function drawIcon(size, { inset, bleed }) {
  const px = new Uint8Array(size * size * 4)
  const set = (x, y, colour) => {
    const i = (y * size + x) * 4
    px[i] = colour[0]
    px[i + 1] = colour[1]
    px[i + 2] = colour[2]
    px[i + 3] = colour[3]
  }

  const pad = Math.round(size * inset)
  const boxX0 = pad
  const boxY0 = pad
  const boxX1 = size - pad - 1
  const boxY1 = size - pad - 1
  const boxW = boxX1 - boxX0 + 1
  const radius = Math.round(boxW * 0.22)

  const insideRounded = (x, y) => {
    if (x < boxX0 || x > boxX1 || y < boxY0 || y > boxY1) return false
    // Corner tests.
    const corners = [
      [boxX0 + radius, boxY0 + radius, x < boxX0 + radius && y < boxY0 + radius],
      [boxX1 - radius, boxY0 + radius, x > boxX1 - radius && y < boxY0 + radius],
      [boxX0 + radius, boxY1 - radius, x < boxX0 + radius && y > boxY1 - radius],
      [boxX1 - radius, boxY1 - radius, x > boxX1 - radius && y > boxY1 - radius],
    ]
    for (const [cx, cy, applies] of corners) {
      if (applies) {
        const dx = x - cx
        const dy = y - cy
        return dx * dx + dy * dy <= radius * radius
      }
    }
    return true
  }

  // Ground.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (bleed) set(x, y, BLACK)
      else set(x, y, insideRounded(x, y) ? BLACK : TRANSPARENT)
    }
  }

  // Three white bars of differing lengths — an abstract list mark, not a wordmark.
  const barHeight = Math.round(boxW * 0.1)
  const barGap = Math.round(boxW * 0.11)
  const barX = boxX0 + Math.round(boxW * 0.2)
  const lengths = [0.6, 0.44, 0.52].map((f) => Math.round(boxW * f))
  const blockHeight = barHeight * 3 + barGap * 2
  let barY = boxY0 + Math.round((boxY1 - boxY0 + 1 - blockHeight) / 2)

  for (const length of lengths) {
    for (let y = barY; y < barY + barHeight; y += 1) {
      for (let x = barX; x < barX + length; x += 1) {
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, WHITE)
      }
    }
    barY += barHeight + barGap
  }

  return encodePng(size, px)
}

/* ------------------------------------------------------------------ */

mkdirSync(PUBLIC_DIR, { recursive: true })

const outputs = [
  ['icon-192.png', 192, { inset: 0.04, bleed: false }],
  ['icon-512.png', 512, { inset: 0.04, bleed: false }],
  // Maskable: full-bleed ground, content well inside the centre 80% safe zone.
  ['icon-maskable-512.png', 512, { inset: 0.18, bleed: true }],
  // Apple touch icons are composited on an opaque ground, so this one bleeds too.
  ['apple-touch-icon.png', 180, { inset: 0.1, bleed: true }],
]

for (const [name, size, options] of outputs) {
  writeFileSync(join(PUBLIC_DIR, name), drawIcon(size, options))
}

process.stdout.write(
  `icons generated (achromatic, deterministic)\n` +
    outputs.map(([name, size]) => `  public/${name}  ${size}x${size}\n`).join(''),
)
