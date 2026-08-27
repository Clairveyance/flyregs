import { useEffect, useRef, useState } from 'react'
import { View, StyleSheet, PixelRatio } from 'react-native'
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl'
import { Renderer } from 'expo-three'
import * as THREE from 'three'
import * as Sentry from '@sentry/react-native'
import { equirectToEnvMap, makeBackdropTexture, loadTexture, centeringOffset } from '@/lib/trophy3d/envMap'
import { guardUnsupportedRenderbufferMultisample } from '@/lib/trophy3d/glGuards'

// Real WebGL port of the "Ace" brilliant-cut diamond built and tuned live
// with RC across this whole session's trophy_3d.html prototype -- every
// material value, light position/intensity, and animation formula below
// is copied verbatim from the confirmed-final state of that file, not
// re-derived. See trophy_3d.html's own inline comments for the full
// history of why each value is what it is; this file only explains what's
// different because it's running in React Native instead of a browser.
//
// The two things that couldn't just be copied over:
// 1. RN has no DOM canvas 2D context, so every texture the prototype drew
//    live (gem environment map, the contour-hugging halo, the starburst
//    glint) was baked once to a real PNG (assets/trophy/*.png) by running
//    the exact same drawing code in the actual browser tab RC was looking
//    at, then extracting the canvas via toDataURL -- pixel-identical to
//    what RC approved, not a re-implementation.
// 2. The backdrop plane (what the transmissive gem "sees through" to) is
//    computed live from the theme's real bg2 token instead of a baked PNG,
//    so it stays correct if the theme or its colors ever change -- see
//    envMap.ts's makeBackdropTexture.
export function AceGem3D({ size = 300, backdropColor }: { size?: number; backdropColor: string }) {
  const disposed = useRef(false)
  // RC: "app locks up / closes... during certain functions, or
  // tapping/moving through certain parts too fast." Root cause: every
  // popup open ran onContextCreate from scratch (renderer, 3 textures, a
  // PMREM env map, geometry, materials, 15+ lights) but unmounting only
  // ever stopped the animate() loop -- none of those GPU-side allocations
  // were ever released. Three.js explicitly requires manual .dispose()
  // calls to free GPU memory; JS garbage collection has no visibility
  // into it. Repeatedly opening/closing this popup (exactly "tapping
  // through" a trophy) accumulated leaked renderer/texture/geometry
  // memory every time with nothing ever giving it back, a real match for
  // Sentry's own WatchdogTermination ("terminated your app, possibly
  // because it overused RAM"). disposablesRef collects everything
  // onContextCreate creates that has a .dispose() method; the cleanup
  // below disposes all of it, and the renderer's own GL context loss
  // extension (forceContextLoss) releases the native backing store too.
  const disposablesRef = useRef<{ dispose: () => void }[]>([])
  // RC, live: "what happened to the diamond? it disappeared." Root cause:
  // onContextCreate is async (3 sequential texture loads + a PMREM
  // env-map generation pass, all before the first real frame renders) and
  // this component remounts from scratch every time the popup opens --
  // nothing was ever cached or shown in the meantime, so the canvas was
  // genuinely blank (transparent, alpha:true, nothing drawn yet) for that
  // whole window. `ready` gates a placeholder that covers exactly that
  // window; it also never gets set if the async chain throws (a real
  // texture-load failure), so a genuine failure now shows the same
  // graceful placeholder forever instead of a silent, permanently-blank
  // void -- see the try/catch in onContextCreate below.
  const [ready, setReady] = useState(false)

  // The animate() loop below checks this each frame and stops recursing
  // once true -- without it, closing the popup (unmounting this component)
  // would leave the requestAnimationFrame loop running forever against a
  // destroyed GL context.
  useEffect(() => {
    return () => {
      disposed.current = true
      for (const d of disposablesRef.current) {
        try { d.dispose() } catch { /* already-torn-down GL context, nothing left to free */ }
      }
      disposablesRef.current = []
    }
  }, [])

  const onContextCreate = async (gl: ExpoWebGLRenderingContext) => {
    // RC, real device: crashed opening the diamond ("EXGL:
    // renderbufferStorageMultisample() isn't implemented yet!"). Root cause
    // and why this is a SHARED guard now (not just this component's own
    // fix): see glGuards.ts's own header comment. The lost MSAA on the
    // rare code path this actually intercepts is on an internal offscreen
    // snapshot the gem's own material already heavily blurs via
    // IOR/roughness/clearcoat, imperceptible in practice.
    guardUnsupportedRenderbufferMultisample(gl)

    // RC, real device + web preview: a large black rectangle instead of a
    // transparent/correctly-filled canvas. Root cause: the web prototype's
    // makeRenderer() explicitly passed `alpha: true` to WebGLRenderer --
    // dropped in this port. Without it, WebGL defaults to fully opaque
    // rendering, so any pixel the scene doesn't explicitly paint reads as
    // solid black instead of transparent, instead of letting whatever's
    // behind the canvas show through.
    const renderer = new Renderer({ gl, alpha: true, antialias: true })
    // RC: "not centered at all." expo-three's Renderer defaults
    // pixelRatio to 1 in its own constructor, NOT the device's real
    // devicePixelRatio -- the web prototype's makeRenderer() always called
    // setPixelRatio(min(devicePixelRatio,2)) explicitly, right before
    // setSize(), and this port dropped that call entirely. With the GL
    // viewport and the canvas's actual drawing-buffer resolution disagreeing
    // on scale, the rendered image can land off-center within its own
    // canvas even though the canvas element itself is correctly centered
    // on the page (confirmed via direct DOM measurement -- the canvas box
    // WAS centered; only the picture drawn inside it wasn't). Matching the
    // original's exact call order fixes the mismatch at its source.
    renderer.setPixelRatio(Math.min(PixelRatio.get(), 2))
    // RC: render overlapping the text/Close button below it -- the canvas
    // was displaying at 670x670 (2x the intended 335x335) even though its
    // wrapping View was correctly sized. Root cause, confirmed via direct
    // inspection of the canvas's own `style` attribute: it was completely
    // EMPTY -- setSize()'s default `updateStyle=true` behavior (set
    // canvas.style.width/height to the logical size) wasn't taking effect
    // against GLView's own canvas management, so the browser fell back to
    // sizing the canvas from its raw width/height ATTRIBUTES (the
    // pixelRatio-scaled drawing-buffer resolution) instead of a CSS size.
    // The web prototype's own makeRenderer() already called
    // `setSize(size, size, false)` -- that trailing `false` was dropped in
    // this port. Restoring it tells three.js to manage ONLY the drawing
    // buffer and leave canvas.style alone entirely, so the wrapping
    // View's own explicit width/height (via GLView's StyleSheet.absoluteFill)
    // is the single source of truth for the DISPLAYED size, with no
    // possible conflict between two different sizing mechanisms.
    renderer.setSize(size, size, false)
    renderer.setClearColor(0x000000, 0)
    // RC: "the globe got too 'brown'... bring back the gold look" (same
    // missing setting affects the gem's own colors too, fixed here for the
    // same reason). Root cause: makeRenderer() in the web prototype
    // explicitly set this -- missed entirely in this port. Without it,
    // the renderer's linear-space output gets displayed as if it were
    // already sRGB, which reads as darker and less saturated than
    // intended -- exactly "gold reading as brown."
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
    camera.position.set(0, 0.15, 4.2)

    // Backdrop plane -- fills the whole frustum, textured with the real
    // popup card color (tokens.bg2) so the gem's transmission has actual
    // tonal variation to bend, and reads as the same surface the card
    // itself sits on, not a foreign background.
    // RC round 8 attempted `transparent: true` here (reading
    // makeBackdropTexture's alpha channel) to fade this plane's edges to
    // nothing instead of clipping them -- RC caught the real result:
    // "what did you do??? you messed up the diamond." Root cause: this
    // material's `transmission: 1.0` makes three.js render it via a
    // transmission pass that samples an internal render-to-texture
    // snapshot of the OPAQUE scene as the "what's behind this gem" source
    // -- objects marked `transparent: true` are excluded from that
    // snapshot. Making the backdrop transparent didn't just fade its
    // edges, it removed the ONLY thing the gem's transmission was
    // supposed to see, which is why the whole gem went washed-out/white
    // instead of reading as a dark backdrop bent through its facets.
    // Reverted to opaque -- this plane has to stay opaque for the gem's
    // core "black diamond" look to work at all, so the edge-fade this was
    // trying to achieve needs a different mechanism that doesn't touch
    // this material's transparency.
    const backdropTex = makeBackdropTexture(backdropColor)
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ map: backdropTex })
    )
    backdrop.position.set(0, 0, -3.5)
    scene.add(backdrop)

    // Gem's own dark-navy environment (not shared with the globe) -- see
    // trophy_3d.html's buildGemEnvironment history for why: reflecting
    // ANY light color off a dark, mostly-transmissive gem reads as a pale
    // wash, so the environment itself needs to be dark to match the
    // backdrop, with only small genuinely-bright spots for real glimmer.
    const envRaw = await loadTexture(require('../../assets/trophy/gem_env.png'))
    const env = equirectToEnvMap(renderer, envRaw as THREE.Texture)
    scene.environment = env
    // 1.1 -> 1.35, alongside the material's own envMapIntensity/iridescence
    // bump below -- see that comment for why (facet reflectivity restored
    // without touching `side`).
    scene.environmentIntensity = 1.35

    // Brilliant-cut profile: [radius, y] pairs, revolved around Y.
    const pts = [
      new THREE.Vector2(0.001, 1.05),
      new THREE.Vector2(0.34, 1.02),
      new THREE.Vector2(0.34, 0.98),
      new THREE.Vector2(0.98, 0.55),
      new THREE.Vector2(0.98, 0.5),
      new THREE.Vector2(0.001, -1.15),
    ]
    const geo = new THREE.LatheGeometry(pts, 12)
    geo.computeVertexNormals()

    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0.0,
      roughness: 0.01,
      // RC, 2026-08-27: "the diamond has sort of lost its multiple facets
      // that reflect the light better like it had before." Correcting this
      // file's own earlier claim just below (kept, struck through in
      // spirit, not deleted -- the reasoning for FrontSide itself is still
      // right, only the "no visual difference" part was wrong): read
      // three.js's actual WebGLRenderer.renderTransmissionPass source
      // (node_modules/three/src/renderers/WebGLRenderer.js) rather than
      // re-guessing. The back-face pass it skips when side !== DoubleSide
      // is exactly what samples this material's own back geometry for
      // thickness-aware internal light bounce -- losing it measurably
      // flattened the per-facet brightness/color variation that reads as
      // "sparkle," confirmed side-by-side in a standalone browser
      // prototype (three of these materials, side by side, FrontSide vs.
      // this tuned FrontSide vs. DoubleSide) before touching this file.
      // transmission 1.0->0.8, iridescence 0.55->0.85, envMapIntensity
      // 1.3->2.3 (paired with scene.environmentIntensity 1.1->1.35 above)
      // recovers real, visible facet-edge definition and iridescent color
      // shift through the FRONT-face reflection/clearcoat pipeline alone --
      // a pipeline untouched by the DoubleSide bug, so this is additive,
      // not a partial revert. Does not fully match DoubleSide's richness
      // (that gap is real and is specifically the internal-bounce
      // component only the buggy path computes) but it's a genuine step in
      // that direction with none of the real, device-confirmed risk.
      transmission: 0.8,
      thickness: 1.1,
      ior: 2.4,
      attenuationColor: 0xffffff,
      attenuationDistance: 3,
      iridescence: 0.85,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [100, 500],
      clearcoat: 1.0,
      clearcoatRoughness: 0.01,
      envMapIntensity: 2.3,
      // RC, B34, real device: "rotation is super glitchy... color is
      // glitching too... green flashes." DoubleSide on a transmissive
      // material makes three.js render an EXTRA back-face pass every
      // single frame (renderTransmissionPass toggles material.side to
      // BackSide, re-renders, toggles back -- see three.module.js's
      // WebGLRenderer around its transmission-pass handling), each flip
      // setting material.needsUpdate = true, which forces a program
      // recompile/swap. That's on top of the transmission pass ALREADY
      // rendering a full extra scene into a 536x536 HalfFloat render
      // target and generating its mipmap chain TWICE. This gem never
      // needs its back faces -- it's convex and always viewed from
      // outside -- so FrontSide removes the entire duplicate pass (half
      // the per-frame transmission cost, zero needsUpdate churn). Directly
      // targets both reported symptoms: the removed per-frame stutter is
      // the most likely cause of "super glitchy" rotation, and the removed
      // SECOND mipmap generation on that HalfFloat target is the most
      // likely cause of the intermittent green flashes (an uninitialized/
      // driver-dependent mip level under iOS GLES3, sampled every frame by
      // the transmission shader). Keep FrontSide -- see the facet-richness
      // comment above for what's traded away by keeping it, and why that
      // trade is still the right one.
      side: THREE.FrontSide,
      flatShading: true,
    })
    const gem = new THREE.Mesh(geo, mat)
    scene.add(gem)

    // Contour-hugging halo -- baked from the exact same lathe profile
    // above (mirrored into a closed outline and stroked), so it traces
    // the diamond's true silhouette at every rotation angle instead of
    // approximating it with a circle. See gem_halo.png's generation and
    // trophy_3d.html's round-7 comments for why a circle/ring wasn't
    // right and why a filled disc washed out the tip.
    const haloTex = await loadTexture(require('../../assets/trophy/gem_halo.png'))
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: haloTex as THREE.Texture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.85,
      })
    )
    halo.position.set(0, -0.05, -0.6)
    // RC round 9: "all four sides just end in a hard break," then after an
    // initial fix: "the top three edges are better now. but the bottom
    // one is still very hard." Root cause: the halo sprite's own texture
    // (gem_halo.png) has a smooth alpha falloff, verified by sampling it
    // directly with PIL -- it doesn't actually reach near-zero alpha until
    // about 90% of its own radius. At a large enough sprite scale, the
    // CAMERA's frustum edge clips the sprite before that falloff
    // finishes -- a real GPU-level cutoff, not a texture or blending
    // issue, so no amount of material tuning fixes it, only staying
    // inside the visible frustum does. The frustum isn't symmetric around
    // this sprite either: the camera sits at y=0.15 with no compensating
    // tilt (camera.position.set(0, 0.15, 4.2)), so its view is centered
    // on world y=0.15, not y=0 -- at the halo's z=-0.6 (distance 4.8,
    // 35deg vertical FOV, half-height ~1.513), the visible range is
    // roughly y=[-1.363, 1.663]. The halo sits at y=-0.05 (matching the
    // diamond's own visual center -- moving it would misalign the glow
    // from the gem it's supposed to outline), which leaves only ~1.31
    // units of margin below it vs. ~1.71 above -- the bottom was always
    // the tighter constraint, which is exactly why shrinking enough to
    // fix top/left/right (scale 3.2) still weren't enough for the bottom
    // specifically. Solved for the bottom margin directly: needs
    // scale/2 * 0.90 <= 1.31, i.e. scale <= ~2.9.
    halo.scale.set(2.8, 2.8, 1)
    scene.add(halo)

    // 15 jittered/pulsed point lights -- scattered top/side/back/lower
    // angles (not a symmetric ring), each drifting on its own
    // uncorrelated orbit and pulsing on a sparse, non-periodic cycle. See
    // trophy_3d.html rounds 1-7 for the full history of why these exact
    // positions/intensities/frequencies.
    const lightColors = [0xffffff, 0xfafcff, 0xffffff, 0xd8e8ff, 0xffffff, 0xeef6ff]
    const lightPositions: [number, number, number][] = [
      [0.3, 3.1, 0.7], [0.6, 3.0, -2.0], [-2.1, 2.6, -0.5], [2.3, 2.3, -1.1],
      [3.2, 0.0, -0.2], [-3.2, 0.15, 0.3],
      [2.6, -1.5, -0.8], [-2.6, -1.3, 0.5], [-0.5, 1.6, -2.7], [0.7, -2.0, -2.5],
      [2.0, -2.4, 1.6], [-2.0, -2.2, 1.8],
      [-1.4, -1.7, 1.1], [-2.4, -1.9, 0.6], [-1.0, -2.5, 1.4],
    ]
    const lightIntens = [7.4, 6.2, 6.8, 6.4, 6.0, 5.8, 6.2, 5.8, 6.6, 5.6, 6.6, 9.2, 8.4, 8.8, 8.0]
    const gemLights = lightPositions.map((pos, i) => {
      const pl = new THREE.PointLight(lightColors[i % lightColors.length], lightIntens[i], 14)
      pl.position.set(pos[0], pos[1], pos[2])
      scene.add(pl)
      return { light: pl, base: pos, baseIntensity: lightIntens[i], seed: i * 2.37 + 0.6, freq: 0.12 + i * 0.041 }
    })

    // Two genuinely constant (unjittered, un-pulsed) spotlights, so
    // facets sweeping through them as the gem rotates catch a real,
    // reliable, predictable glint -- RC's explicit "constant spot light"
    // request, twice (lower-left, then lower-center/right).
    const lowerLeftSpot = new THREE.PointLight(0xffffff, 8.5, 16)
    lowerLeftSpot.position.set(-2.2, -2.0, 1.3)
    scene.add(lowerLeftSpot)
    const lowerCenterSpot = new THREE.PointLight(0xffffff, 8.5, 16)
    lowerCenterSpot.position.set(0.8, -2.2, 1.6)
    scene.add(lowerCenterSpot)

    const sparkle = new THREE.PointLight(0xffffff, 4.5, 8)
    sparkle.position.set(1.6, 1.8, 2.4)
    scene.add(sparkle)
    scene.add(new THREE.AmbientLight(0xffffff, 0.1))

    const topLight = new THREE.DirectionalLight(0xffffff, 2.7)
    topLight.position.set(0.3, 5, 0.6)
    scene.add(topLight)
    const key = new THREE.DirectionalLight(0xffffff, 0.3)
    key.position.set(2.6, 1, 0.4)
    scene.add(key)

    const backlight = new THREE.PointLight(0xffffff, 14, 20)
    backlight.position.set(0, 0.2, -3.2)
    scene.add(backlight)
    const backlight2 = new THREE.PointLight(0xffffff, 8, 16)
    backlight2.position.set(1.2, -0.6, -2.6)
    scene.add(backlight2)

    // Starburst glint sprites -- pseudo-random facet twinkle.
    const glintTex = await loadTexture(require('../../assets/trophy/glint.png'))
    const glintSlots: [number, number, number][] = [
      [0.5, 0.5, 0.9], [-0.55, 0.15, 0.75], [0.2, -0.5, 0.85], [-0.3, 0.6, 0.7], [0.6, -0.15, 0.8], [-0.1, -0.7, 0.75],
    ]
    const glints = glintSlots.map((p, i) => {
      const spr = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glintTex as THREE.Texture, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
      )
      spr.position.set(p[0], p[1], p[2])
      spr.scale.set(0.001, 0.001, 1)
      spr.userData.seed = i * 1.7 + 0.4
      scene.add(spr)
      return spr
    })

    const clock = new THREE.Clock()
    // RC, B34, real device: "freezes entirely after a couple of turns."
    // The try/catch below (see its own comment) was correctly designed to
    // turn a fatal per-frame exception into a non-fatal one -- but it did
    // that by setting disposed.current permanently true on the FIRST
    // error, stopping every future frame forever, which is exactly a
    // permanent on-screen freeze the moment any single frame throws once.
    // A transient GL hiccup (this device's expo-gl/GLES3 stack has
    // several documented rough edges around this exact transmissive-
    // material code path -- see the material comment above) shouldn't
    // permanently kill an otherwise-fine animation. Tolerates a handful of
    // CONSECUTIVE failures (resets to 0 on every good frame) before truly
    // giving up -- still reports every single failure to Sentry so a real
    // recurring problem stays fully visible there, it just no longer
    // freezes the trophy on the first isolated one.
    let consecutiveErrors = 0
    const MAX_CONSECUTIVE_ERRORS = 8
    const animate = () => {
      if (disposed.current) return
      requestAnimationFrame(animate)
      const t = clock.getElapsedTime()
      // RC, B34, real device: "spinning too fast." The true angular rate
      // (below) is unchanged from the original tuning -- one full
      // revolution every 2*pi/rate seconds regardless of frame rate, since
      // this is elapsed-wall-clock-time-based, not a per-frame increment.
      // What actually reads as "fast" is perceptual: LatheGeometry(pts, 12)
      // a few lines up is 12-fold rotationally symmetric with flatShading,
      // so its FACET pattern repeats every 360/12 = 30 degrees -- at the
      // previous 0.25 rad/s that's a visible facet-cycle every ~2.1s, much
      // more often than the nominal ~25s/revolution, and the per-frame
      // judder fixed above (the DoubleSide removal) made that aliasing
      // read as even faster/choppier. Halved here so the perceived
      // facet-cycle roughly doubles to ~4.2s -- keep LOCKED_SPIN_MS in
      // TrophyBadge.tsx (the flat 2D grid-tile badge's own CSS-style spin,
      // deliberately kept in sync with this rate) updated in lockstep if
      // this ever changes again.
      gem.rotation.y = t * 0.125
      gem.rotation.x = Math.sin(t * 0.4) * 0.12 + 0.08
      backdrop.rotation.z = t * 0.1
      const haloPulse = Math.sin(t * 0.7) * 0.5 + 0.5
      // RC, live: "bring back just a bit more glow around the diamond."
      // Raised via opacity (0.7-0.95 -> 0.8-1.0), not scale -- scale is
      // capped at ~2.9 by the frustum-clipping fix documented just above
      // (round 9's hard-edge bug), so opacity is the only safe lever left
      // for "more glow" without reintroducing that.
      ;(halo.material as THREE.SpriteMaterial).opacity = 0.8 + haloPulse * 0.2
      // Kept under the ~2.9 ceiling worked out above (the tighter BOTTOM
      // margin, not the top/sides) at every point in the pulse cycle, not
      // just at rest.
      const haloScale = 2.8 + haloPulse * 0.08
      halo.scale.set(haloScale, haloScale, 1)

      gemLights.forEach((gl2) => {
        const p = gl2.base
        const f = gl2.freq
        const s = gl2.seed
        gl2.light.position.set(
          p[0] + Math.sin(t * f + s) * 0.5,
          p[1] + Math.sin(t * f * 1.3 + s * 1.7) * 0.42,
          p[2] + Math.cos(t * f * 0.8 + s * 2.3) * 0.5
        )
        const phase = t * f * 0.35 + s + 0.6 * Math.sin(t * 0.037 + s * 2.7)
        const pulse = Math.max(0, Math.sin(phase))
        gl2.light.intensity = gl2.baseIntensity * (0.06 + 1.1 * Math.pow(pulse, 12))
      })

      glints.forEach((spr) => {
        const phase = (t * 2.0 + spr.userData.seed * 3.1) % (Math.PI * 2)
        const pulse = Math.max(0, Math.sin(phase))
        const burst = Math.pow(pulse, 8)
        ;(spr.material as THREE.SpriteMaterial).opacity = burst
        const s = 0.06 + burst * 0.26
        spr.scale.set(s, s, 1)
      })

      // RC, real device, build 33: the "renderbufferStorageMultisample()
      // isn't implemented yet!" crash (see glGuards.ts) reached the app as
      // a genuinely UNHANDLED exception -- confirmed via Sentry's own tags
      // on that event (`handled: no, mechanism: onerror`), NOT caught by
      // this component's onContextCreate(gl).catch() below. Root cause:
      // that .catch() only wraps the async SETUP phase (onContextCreate's
      // own promise). animate() is called once synchronously at the end of
      // that phase, so frame 1 alone runs inside it -- but every frame
      // after that runs via requestAnimationFrame, a completely separate
      // call stack outside that promise chain entirely, with zero error
      // boundary. React Native has no implicit per-frame error boundary
      // the way a component tree's <ErrorBoundary> catches render throws,
      // so ANY exception here (this specific bug, a different expo-gl
      // native gap -- see glGuards.ts's UNIMPL_NATIVE_METHOD list, a
      // future three.js version bump, anything) was fatal to the whole
      // app, on every single frame, for the popup's entire open lifetime.
      // Catching here doesn't fix whatever specific thing throws -- it
      // makes the FAILURE MODE non-fatal: report every failure, but only
      // truly stop scheduling frames after MAX_CONSECUTIVE_ERRORS in a row
      // (see that constant's own comment above, added B34 -- a single
      // transient error used to freeze the trophy permanently, which is
      // exactly RC's "freezes entirely after a couple of turns" report).
      try {
        renderer.render(scene, camera)
        gl.endFrameEXP()
        consecutiveErrors = 0
      } catch (err) {
        consecutiveErrors++
        Sentry.captureException(err)
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          disposed.current = true
        }
        return
      }
    }

    // Every GPU-side allocation this function created, for the unmount
    // cleanup above to free -- see disposablesRef's own comment for why
    // this exists.
    //
    // Real Sentry WatchdogTermination, 2026-08-20 17:59 UTC (production
    // B34): thread dump showed the JS thread and Hermes GC completely
    // idle -- the main thread was parked in CA::Render::Encoder, GPU
    // threads blocked in gldGenerateTexMipmaps/Metal command-buffer
    // submission -- a native GPU/memory stall, not a JS hang. Breadcrumbs
    // showed the trophy popup opened 3 times in 6 minutes; by the kill,
    // app_memory was 728MB with thermal_state "serious". Root cause:
    // `renderer.forceContextLoss()` below is a WebGL-spec extension call
    // (`WEBGL_lose_context`) that expo-gl's ExpoWebGLRenderingContext does
    // NOT implement -- it silently no-ops instead of throwing, so every
    // popup open/close cycle disposed the JS-side three.js buffers
    // correctly but leaked the underlying native EXGL context (and its
    // GPU-side render targets/textures) permanently. `GLView.destroyContextAsync(gl)`
    // is expo-gl's own real API for this (node_modules/expo-gl/build/GLView.d.ts)
    // -- unlike forceContextLoss, this one actually reaches native code and
    // frees the context. Kept forceContextLoss too (harmless no-op, not
    // worth a separate PR to remove) rather than assume nothing else could
    // ever depend on it firing.
    disposablesRef.current = [
      geo, mat, backdrop.geometry, backdrop.material as THREE.Material, backdropTex,
      envRaw as THREE.Texture, env, haloTex as THREE.Texture, halo.material as THREE.Material,
      glintTex as THREE.Texture, ...glints.map((spr) => spr.material as THREE.Material),
      { dispose: () => renderer.dispose() },
      { dispose: () => renderer.forceContextLoss() },
      { dispose: () => { GLView.destroyContextAsync(gl).catch(() => {}) } },
    ]

    // Flips the placeholder off right as the first real frame is about to
    // render -- guarded on disposed.current since the popup can close
    // (unmounting this component) while these awaits above were still in
    // flight, and setting state on an unmounted component logs a warning.
    if (!disposed.current) setReady(true)
    animate()
  }

  // RC: "way too small and not centered." `position: 'relative'` is
  // explicit here (not just relying on default View behavior) since
  // GLView's absoluteFill child positions itself relative to whatever its
  // nearest POSITIONED ancestor is -- without this being unambiguous, it's
  // possible for the canvas to anchor to a larger/different ancestor and
  // read as mis-centered relative to this box specifically.
  return (
    <View style={{ width: size, height: size, position: 'relative', alignSelf: 'center' }}>
      {/* Sits BEHIND the canvas (mounted first) so it's naturally covered
          once real frames start drawing over it, and stays visible as a
          graceful fallback in the genuine-failure case (onContextCreate's
          promise rejects below) instead of a silent, permanently-blank
          canvas. */}
      {!ready && (
        <View
          pointerEvents="none"
          style={{
            width: size, height: size, borderRadius: size / 2,
            backgroundColor: 'rgba(79,209,255,0.12)',
          }}
        />
      )}
      {/* B34: replaces the empirical +18/-22 nudge with centeringOffset(),
          computed from the real pixel-ratio mismatch (see that function's
          own comment). The gem also carries one small ADDITIONAL y-only
          correction the globe doesn't need: camera.position above is
          (0, 0.15, 4.2) with no lookAt, so the view is centered on world
          y=0.15, not the gem's own true visual center -- the lathe profile
          a few lines up spans y=[+1.05, -1.15], bounding-box center
          y=-0.05 (matching the halo sprite's own position a few lines up,
          which was independently placed to track the gem's visual
          center). That 0.20-unit gap, projected through this camera's FOV
          at the gem's depth, works out to ~9.95% of `size` -- deliberately
          NOT fixed by adding a camera.lookAt() instead, since that would
          also rotate the view frustum and risk disturbing the halo's own
          hard-won frustum-edge-clipping tuning (see the halo's "round 9"
          comment above) for a component this file's header already says
          is copied verbatim from a live-tuned prototype. */}
      <GLView
        style={[StyleSheet.absoluteFill, { transform: [{ translateX: centeringOffset(size) }, { translateY: -(centeringOffset(size) + size * 0.0995) }] }]}
        // Not awaited/caught by GLView itself -- a rejection inside
        // onContextCreate (e.g. a real texture-load failure) would
        // otherwise be a silent unhandled promise rejection, leaving
        // `ready` stuck false forever with no record anywhere that
        // anything went wrong. Deliberately NOT touching onContextCreate's
        // own ~260-line body (every value in it is copied verbatim from
        // the tuned prototype, see this file's header comment) to add
        // this -- catching at the call site instead.
        onContextCreate={(gl) => { onContextCreate(gl).catch((err) => Sentry.captureException(err)) }}
      />
    </View>
  )
}
