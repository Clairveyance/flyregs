import { PixelRatio } from 'react-native'
import * as THREE from 'three'
import { TextureLoader } from 'expo-three'

// RC, B34, real device: "still not centered... judge your adjustment
// further right, slightly up" (gem), "still slightly off-center" (globe).
// Shared by both trophies (AceGem3D.tsx, MasterGlobe3D.tsx) since they use
// the identical GLView/Renderer setup and hit the identical root cause.
// Root cause, actually diagnosed this round instead of re-guessed:
// `renderer.setPixelRatio(Math.min(PixelRatio.get(), 2))` in both files
// deliberately caps the RENDERED resolution at 2x for performance, but
// expo-gl's iOS GLView still sizes the real native framebuffer at the
// device's TRUE screen scale (`contentScaleFactor` -- 3x on most current
// iPhones). WebGLRenderer.setSize(size, size, false) draws into a
// viewport sized by the pixelRatio it was TOLD (2x), which only fills a
// fraction (renderedScale/actualScale, e.g. 2/3) of that larger real
// buffer -- and since GL's viewport origin is bottom-left, the content
// ends up rendered at that fraction's scale, anchored to the bottom-left
// corner of the view, instead of filling and centering in it. Computed
// from the actual runtime pixel ratio (matches a real 3x device's math
// exactly: at 268pt this popup uses, works out to +/-44.67pt, not a
// re-guessed constant) rather than a fixed nudge -- on a 2x device (many
// Androids, iPad, older iPhones) actualScale <= 2 means
// renderedScale/actualScale = 1 and this correctly resolves to a NO-OP
// instead of a fixed old nudge actively mis-centering a device that never
// had the mismatch in the first place.
export function centeringOffset(size: number): number {
  const actualScale = PixelRatio.get()
  const renderedScale = Math.min(actualScale, 2)
  return (size / 2) * (1 - renderedScale / actualScale)
}

// RC, real device + web preview: "ExpoTHREE.loaderClassForExtension():
// Unrecognized file type png." `ExpoTHREE.loadAsync()` is a generic
// dispatcher that sniffs the resolved asset URL's extension to pick a
// loader (models vs. images) -- on web specifically, Metro's resolved
// asset URL for a `require('*.png')` doesn't always come back as a plain
// string ending in `.png` the way `loadAsync`'s regex expects, so it fell
// through to the model-loader path and threw. `TextureLoader` (also
// exported by expo-three) is the loader written specifically for images --
// no extension-sniffing at all, just always treats the asset as a
// picture -- so it sidesteps this failure mode entirely instead of
// depending on how a given platform happens to format the resolved URL.
function loadTexture(asset: number): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new TextureLoader().load(asset, resolve, undefined, reject)
  })
}

export { loadTexture }

// Mirrors trophy_3d.html's renderEnvCanvas: given a flat equirectangular
// texture (loaded from one of the baked PNGs in assets/trophy/), run it
// through PMREMGenerator to get a real prefiltered environment map --
// the same GPU-side step the web prototype did with a live canvas.
export function equirectToEnvMap(renderer: THREE.WebGLRenderer, tex: THREE.Texture): THREE.Texture {
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envMap = pmrem.fromEquirectangular(tex).texture
  pmrem.dispose()
  return envMap
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '')
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  const num = parseInt(full, 16)
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 }
}

// RN has no DOM canvas 2D context, so the web prototype's
// buildAppBgBackdrop() (a radial gradient baked per-frame from the app's
// bg color) can't be replicated with canvas drawing calls -- and baking a
// static PNG per theme would go stale the moment a theme's token value
// changes. This computes the same "center lifted slightly off the base
// color, settling back within a small radius" gradient directly into a
// DataTexture's pixel buffer, so it stays live/theme-reactive with no
// bundled asset at all. See buildAppBgBackdrop's own comments in
// trophy_3d.html for why a flat single color reads as "opaque" instead of
// "something to see through" -- this is the same fix, just computed
// instead of drawn.
// RC round 8: "the glow has a hard circular edge, all that needs to fade
// to infinity." Tried fading this texture's own alpha to 0 toward its
// edges (instead of the circular `overflow:hidden` clip in
// profile/[userId].tsx) so the backdrop would blend into the wrapping
// native View instead of being clipped -- REVERTED. This material's
// `transmission: 1.0` (in AceGem3D.tsx) makes three.js render it via a
// transmission pass that snapshots the OPAQUE scene as "what's behind
// this gem"; objects marked `transparent: true` are excluded from that
// snapshot entirely. Making this backdrop transparent didn't fade its
// edges, it removed the only thing being transmitted through the gem,
// and the whole diamond went washed-out/white instead of reading as a
// dark backdrop bent through its facets ("you messed up the diamond").
// This plane has to stay fully opaque for the gem's core look to work,
// so alpha here is always 255 -- softening the edge needs a mechanism
// that doesn't touch this material's transparency (currently: the
// circular clip, imperfect but doesn't break transmission).
export function makeBackdropTexture(baseColorHex: string, size = 256): THREE.DataTexture {
  const base = hexToRgb(baseColorHex)
  const lighten = (c: number) => Math.min(255, Math.round(c + (255 - c) * 0.12))
  const center = { r: lighten(base.r), g: lighten(base.g), b: lighten(base.b) }
  const data = new Uint8Array(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const settleRadius = size * 0.15
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const t = Math.min(1, dist / settleRadius)
      const idx = (y * size + x) * 4
      data[idx] = Math.round(center.r + (base.r - center.r) * t)
      data[idx + 1] = Math.round(center.g + (base.g - center.g) * t)
      data[idx + 2] = Math.round(center.b + (base.b - center.b) * t)
      data[idx + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  // DataTexture's inherited default minFilter needs mipmaps, and this
  // never generates any -- under WebGL2's stricter texture-completeness
  // rules (unlike WebGL1's laxer fallback), sampling an incomplete
  // texture like that silently returns black, which is exactly the "the
  // backdrop plane just renders as a black rectangle" bug this shipped
  // with initially. Explicit non-mipmap filtering is the standard fix.
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}
