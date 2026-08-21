// Generate the app's brand assets from the real Ascension IT logo.
//   node scripts/gen-brand.mjs
// Source is public/brand/ascension-it-logo.jpeg (the client's supplied mark). The mark is
// trimmed and its white field is keyed OUT to transparency, so it blends on any surface (the
// header is #fff, the sign-in page is #fbfaf7). Icons re-composite it on white for the OS.
import sharp from 'sharp'

const SRC = 'public/brand/ascension-it-logo.jpeg'
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 }

// Trim the white border to the mark's bounding box.
const trimmed = await sharp(SRC).trim({ threshold: 12 }).toBuffer()

// Key near-white pixels to transparent. The gradient (navy→cyan) never reads as white on all
// three channels, so only the field and the triangle's inner counter are removed.
const { data, info } = await sharp(trimmed).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
for (let i = 0; i < data.length; i += 4) {
  if (data[i] > 242 && data[i + 1] > 242 && data[i + 2] > 242) data[i + 3] = 0
}
const mark = await sharp(data, { raw: info }).png().toBuffer()
console.log(`keyed mark: ${info.width}x${info.height}`)

// Header/login mark: transparent, scaled up for retina.
await sharp(mark).resize({ height: 512, fit: 'inside' }).png().toFile('public/brand/ascension-mark.png')

// Square icon: transparent mark centred on white, `pad` fraction of clear space per side.
async function icon(size, pad, out) {
  const inner = Math.round(size * (1 - pad * 2))
  const logo = await sharp(mark).resize({ width: inner, height: inner, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer()
  await sharp({ create: { width: size, height: size, channels: 4, background: WHITE } })
    .composite([{ input: logo, gravity: 'center' }])
    .png().toFile(out)
  console.log(`wrote ${out}`)
}

await icon(192, 0.14, 'public/icon-192.png')
await icon(512, 0.14, 'public/icon-512.png')
await icon(512, 0.22, 'public/icon-maskable-512.png')
await icon(180, 0.12, 'public/apple-touch-icon.png')
await icon(64, 0.08, 'app/icon.png')
console.log('brand assets generated')
