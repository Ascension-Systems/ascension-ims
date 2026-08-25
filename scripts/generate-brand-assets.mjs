/**
 * Generates every app icon and splash asset from the Plantation Prestige mark.
 *
 * Replaces the previous pipeline, which derived all of these from the Ascension IT logo
 * (public/brand/ascension-it-logo.jpeg). That source is gone, and nothing in the product may
 * carry the previous client's mark: the home-screen icon and the launch screen are the two
 * places a stale logo survives longest, because neither is visible while using the app.
 *
 * The mark matches components/logo.tsx: brand brown ground, cream "PP" set in a serif.
 * It is drawn here rather than traced from a bitmap so every size is sharp.
 *
 *   node scripts/generate-brand-assets.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises'
import sharp from 'sharp'

const BROWN = '#5c3d24'
const BROWN_DEEP = '#3e2817'
const CREAM = '#f4ede3'
const PAPER = '#fbfaf7'
const PAPER_DARK = '#14120f'

/**
 * The mark. `inset` leaves transparent padding, used for the maskable icon where the platform
 * crops to a circle and a full-bleed mark would lose its corners.
 */
function markSVG(size, { inset = 0, rounded = true, ground = BROWN } = {}) {
  const box = size - inset * 2
  const r = rounded ? box * 0.22 : 0
  const fontSize = box * 0.42
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect x="${inset}" y="${inset}" width="${box}" height="${box}" rx="${r}" fill="${ground}"/>
    <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central"
          font-family="Georgia, 'Iowan Old Style', serif" font-size="${fontSize}"
          font-weight="700" letter-spacing="${-fontSize * 0.02}" fill="${CREAM}">PP</text>
  </svg>`)
}

/** Launch screen: the mark centred on the app's own paper, so launch matches first paint. */
function splashSVG(size, dark) {
  const m = size * 0.17
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" fill="${dark ? PAPER_DARK : PAPER}"/>
    <rect x="${(size - m) / 2}" y="${(size - m) / 2}" width="${m}" height="${m}" rx="${m * 0.22}"
          fill="${dark ? BROWN_DEEP : BROWN}"/>
    <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central"
          font-family="Georgia, 'Iowan Old Style', serif" font-size="${m * 0.42}"
          font-weight="700" fill="${CREAM}">PP</text>
  </svg>`)
}

const png = (svg) => sharp(svg).png().toBuffer()

async function main() {
  await mkdir('public/brand', { recursive: true })

  // --- Web / PWA ---
  const web = [
    ['public/icon-192.png', await png(markSVG(192))],
    ['public/icon-512.png', await png(markSVG(512))],
    // Maskable: platforms crop to a circle, so the mark is inset into the safe zone.
    ['public/icon-maskable-512.png', await png(markSVG(512, { inset: 512 * 0.1 }))],
    ['public/apple-touch-icon.png', await png(markSVG(180, { rounded: false }))],
    ['public/brand/pp-mark.png', await png(markSVG(512))],
  ]
  for (const [path, buf] of web) { await writeFile(path, buf); console.log('  wrote', path) }

  // --- iOS app icon: one 1024 square, no transparency (App Store rejects alpha) ---
  const appIcon = await sharp(markSVG(1024, { rounded: false }))
    .flatten({ background: BROWN }).png().toBuffer()
  await writeFile('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', appIcon)
  console.log('  wrote iOS AppIcon-512@2x.png')

  // --- iOS launch screen, light and dark ---
  const light = await png(splashSVG(2732, false))
  const dark = await png(splashSVG(2732, true))
  const dir = 'ios/App/App/Assets.xcassets/Splash.imageset'
  for (const n of ['Default@1x~universal~anyany.png', 'Default@2x~universal~anyany.png', 'Default@3x~universal~anyany.png',
                   'splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    await writeFile(`${dir}/${n}`, light)
  }
  for (const n of ['Default@1x~universal~anyany-dark.png', 'Default@2x~universal~anyany-dark.png', 'Default@3x~universal~anyany-dark.png']) {
    await writeFile(`${dir}/${n}`, dark)
  }
  console.log('  wrote 9 iOS splash images (light + dark)')
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
