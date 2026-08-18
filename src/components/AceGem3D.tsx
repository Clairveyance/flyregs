import { useEffect, useRef, useState } from 'react'
import { View, StyleSheet, PixelRatio } from 'react-native'
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl'
import { Renderer } from 'expo-three'
import * as THREE from 'three'
import * as Sentry from '@sentry/react-native'
import { equirectToEnvMap, makeBackdropTexture, loadTexture } from '@/lib/trophy3d/envMap'
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
    scene.environmentIntensity = 1.1

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
      transmission: 1.0,
      thickness: 1.1,
      ior: 2.4,
      attenuationColor: 0xffffff,
      attenuationDistance: 3,
      iridescence: 0.55,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [100, 500],
      clearcoat: 1.0,
      clearcoatRoughness: 0.01,
      envMapIntensity: 1.3,
      side: THREE.DoubleSide,
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
    const animate = () => {
      if (disposed.current) return
      requestAnimationFrame(animate)
      const t = clock.getElapsedTime()
      gem.rotation.y = t * 0.25
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
      // makes the FAILURE MODE non-fatal: report once, stop scheduling
      // further frames (disposed.current, the same flag unmount cleanup
      // already checks), and let the trophy freeze on its last good frame
      // instead of taking the app down. Structural, independent of which
      // GL call is the next one to throw.
      try {
        renderer.render(scene, camera)
        gl.endFrameEXP()
      } catch (err) {
        disposed.current = true
        Sentry.captureException(err)
        return
      }
    }

    // Every GPU-side allocation this function created, for the unmount
    // cleanup above to free -- see disposablesRef's own comment for why
    // this exists. `forceContextLoss` (not just renderer.dispose(), which
    // only frees the renderer's OWN internal buffers) is what actually
    // releases the underlying GL context's resources back to the OS.
    disposablesRef.current = [
      geo, mat, backdrop.geometry, backdrop.material as THREE.Material, backdropTex,
      envRaw as THREE.Texture, env, haloTex as THREE.Texture, halo.material as THREE.Material,
      glintTex as THREE.Texture, ...glints.map((spr) => spr.material as THREE.Material),
      { dispose: () => renderer.dispose() },
      { dispose: () => renderer.forceContextLoss() },
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
      {/* RC: the Master globe (MasterGlobe3D.tsx) had the identical bug on
          real device -- "off center, low and left" -- root cause not
          diagnosable in this environment (doesn't reproduce in web
          preview; GLView is a genuinely different native component on iOS
          vs. web). RC's own direction for the globe was to apply an
          empirical 2D nudge from the reported direction rather than a
          diagnosed scene/camera fix; applying the SAME correction here
          since RC flagged the diamond is likely off by the same amount in
          the same direction (both trophies share this exact GLView/
          Renderer setup). Same magnitude as the globe's fix -- a first
          estimate, not measured against RC's real device -- expect this
          needs its own follow-up round once RC sees it live. */}
      <GLView
        style={[StyleSheet.absoluteFill, { transform: [{ translateX: 18 }, { translateY: -22 }] }]}
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
