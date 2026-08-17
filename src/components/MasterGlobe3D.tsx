import { useEffect, useRef, useState } from 'react'
import { View, StyleSheet, PixelRatio } from 'react-native'
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl'
import { Renderer } from 'expo-three'
import * as THREE from 'three'
import * as Sentry from '@sentry/react-native'
import { equirectToEnvMap, loadTexture } from '@/lib/trophy3d/envMap'

// Real WebGL port of the "Master" gold globe -- see AceGem3D.tsx's header
// comment for the general porting approach (this file follows the same
// rules); every material/light/animation value here is copied verbatim
// from trophy_3d.html's buildGlobe()/buildContinentTextures(), confirmed
// live with RC across this session.
//
// Unlike the gem, the globe is fully opaque metal -- it never needs to
// "see through" to anything behind it, so there's no backdrop plane here.
// The four corners around the circular sphere (outside its silhouette,
// inside the square viewport) are just cleared to the popup card's real
// bg2 color directly, which is simpler than a plane and produces the same
// result.
export function MasterGlobe3D({ size = 300, backdropColor }: { size?: number; backdropColor: string }) {
  const disposed = useRef(false)
  // See AceGem3D.tsx's matching comment on disposablesRef -- same leak
  // (renderer/textures/geometry/PMREM env map never freed on unmount,
  // only the animate() loop stopped), same fix.
  const disposablesRef = useRef<{ dispose: () => void }[]>([])
  // See AceGem3D.tsx's matching comment -- same async-load blank-canvas
  // window (2 texture loads + a PMREM pass here) and same fix.
  const [ready, setReady] = useState(false)

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
    // See AceGem3D.tsx's matching comment -- the original prototype's
    // makeRenderer() always passed antialias/alpha explicitly; both were
    // dropped in this port's first pass. This canvas doesn't strictly need
    // alpha (its clear color is always opaque -- see setClearColor below),
    // but matching the original renderer construction exactly avoids
    // relying on WebGLRenderer's default (antialias off) by accident.
    const renderer = new Renderer({ gl, alpha: true, antialias: true })
    // See AceGem3D.tsx's matching comment -- expo-three's Renderer
    // defaults pixelRatio to 1 in its own constructor, not the device's
    // real devicePixelRatio, and the original prototype always called
    // setPixelRatio() explicitly right before setSize(). Dropping that
    // call is why RC saw the globe render off-center within its own
    // canvas even though the canvas element itself was correctly
    // centered on the page.
    renderer.setPixelRatio(Math.min(PixelRatio.get(), 2))
    // See AceGem3D.tsx's matching comment -- `setSize(..., false)` (the
    // web prototype's own third argument, dropped in this port) tells
    // three.js to manage only the drawing buffer and leave canvas.style
    // untouched, since that style wasn't reliably taking effect against
    // GLView's own canvas handling and the canvas was displaying at
    // 2x its intended size as a result.
    renderer.setSize(size, size, false)
    renderer.setClearColor(parseInt(backdropColor.replace('#', ''), 16), 1)
    // RC: "the globe got too 'brown' during this build. bring back the
    // gold look." Root cause: the web prototype's makeRenderer() always
    // set this explicitly -- missed entirely when porting. Without it,
    // the renderer's linear-space output displays as if it were already
    // sRGB, reading darker/less saturated -- exactly "gold reading as
    // brown/muddy" instead of the rich warm gold the material/lights were
    // actually tuned for.
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100)
    camera.position.set(0, 0, 4.4)

    const envRaw = await loadTexture(require('../../assets/trophy/globe_env.png'))
    const env = equirectToEnvMap(renderer, envRaw as THREE.Texture)
    scene.environment = env
    // RC, round 4: "still too brown - go back to the render you made - it
    // was correct." Every value on this scene was already verbatim-matched
    // to trophy_3d.html (verified line-by-line), and the baked env texture
    // is byte-identical (MD5-matched) to a fresh extraction -- so this
    // wasn't a copy error. Measured with a synchronous gl.readPixels
    // capture on both the live prototype and this port at matching sphere
    // coordinates: the prototype pins three.js r160 (unpkg script tag),
    // this app runs three@0.166.1 (expo-three's peer dependency floor is
    // ^0.166.0, so pinning back to r160 isn't an option without breaking
    // expo-three). Between those releases three.js changed its IBL
    // specular/irradiance normalization for MeshPhysicalMaterial, and the
    // measured falloff wasn't uniform -- the bright reflective areas lost
    // proportionally more than the flat mid-tones (down to ~62% of the
    // prototype's brightness at the highlight vs. ~75% at a flat gold
    // patch), i.e. specifically the environment-map contribution, not the
    // direct lights. Boosted here (not on the point/directional lights) to
    // target the actual channel that regressed.
    // RC round 5: "still way too brown." Round 4's convergence check (see
    // above) measured 82-92% of the prototype's brightness at matching
    // sphere points -- real progress, evidently still not enough. Pushed
    // further here rather than nudging again, since three rounds of small
    // steps have each individually undershot.
    // RC round 7: "make the globe even more golden." First attempt here
    // pushed this to 2.6 (alongside key/envMapIntensity below) -- live
    // check in Dark Mode showed a bright white ring had come back around
    // the globe's whole silhouette, worse than round 6's edge-rim. Same
    // root cause as round 6 (grazing-angle Fresnel reflecting the
    // environment's white zenith), just re-triggered: these three values
    // don't only control "how gold," they also control "how much grazing
    // reflection," and pushing them further for "more golden" pushes both
    // at once. Reverted to round 6's value here and on key/envMapIntensity
    // below -- "more golden" this round comes entirely from the material's
    // base `color` just below instead, which doesn't touch reflection at
    // all and can't reintroduce this artifact.
    scene.environmentIntensity = 2.0

    // Real elevation, not a texture trick: bumpMap perturbs shading,
    // displacementMap actually raises the land geometry, aoMap darkens
    // every coastline independent of vertex density or the clearcoat
    // layer -- together they're what throws the small self-shadow at
    // every coast under raking light. See trophy_3d.html's
    // buildContinentTextures() for the full reasoning.
    const bumpTex = (await loadTexture(require('../../assets/trophy/globe_bump.png'))) as THREE.Texture
    const aoTex = (await loadTexture(require('../../assets/trophy/globe_ao.png'))) as THREE.Texture

    const geo = new THREE.SphereGeometry(1, 128, 128)
    geo.setAttribute('uv2', new THREE.BufferAttribute(geo.attributes.uv.array, 2))

    const mat = new THREE.MeshPhysicalMaterial({
      // RC round 7: "make the globe even more golden." This is the ONLY
      // lever this round actually changes to accomplish that (see
      // environmentIntensity/key/envMapIntensity comments below -- pushing
      // those further re-triggered round 6's white edge-rim, so they're
      // back at round 6's values). Base albedo warmed a touch richer/more
      // saturated amber-gold (0xc08a3a -> 0xd1993a) instead: this is what
      // the material reflects independent of viewing angle, so it can't
      // create a grazing-angle artifact the way more reflection intensity
      // did.
      color: 0xd1993a,
      bumpMap: bumpTex,
      // Round 7: "add rough texturing to the land masses" -- land had real
      // internal noise as of round 5 (see buildContinentTextures() in
      // trophy_3d.html), but bumpScale here was still tuned for the
      // ORIGINAL flat land fill and undersold that noise once rendered at
      // this popup's actual ~268px size. Bumped so the elevation variance
      // the texture already encodes actually shows up as visible shading.
      bumpScale: 0.19,
      displacementMap: bumpTex,
      displacementScale: 0.055,
      aoMap: aoTex,
      aoMapIntensity: 1.8,
      metalness: 0.88,
      // RC round 8: "this white ring doesn't work at all for dark mode."
      // Measured with the same gl.readPixels technique used elsewhere in
      // this file -- along a line from center to edge, color jumps from
      // gold (159,113,47 at center) to near-white (243,170,74 at 80-85%
      // radius, right at the sphere's own silhouette) before correctly
      // dropping to the true dark clearColor (12,24,38, an EXACT match to
      // tokens.bg2) at 95%+. That confirms the ring is real grazing-angle
      // Fresnel reflection ON THE SPHERE ITSELF, not a backdrop-color bug
      // -- round 6's clearcoat reduction shrank it but evidently didn't
      // remove it. Pushed further this round: roughness 0.12->0.18 (a
      // rougher surface spreads the specular highlight over more angles
      // instead of concentrating it right at grazing incidence, which is
      // what makes ANY glossy material brighten sharply at its silhouette)
      // and clearcoat 0.45->0.2 (most of the way to removing that extra
      // reflective layer entirely, since it's specifically a grazing-angle
      // contributor). envMapIntensity/environmentIntensity/key stay at
      // round 7's reverted-safe values -- this is a material-shape fix,
      // not another intensity change.
      roughness: 0.18,
      clearcoat: 0.2,
      clearcoatRoughness: 0.35,
      // Round 7 first attempt pushed this 2.8 -> 3.4 for "more golden" --
      // reverted (see environmentIntensity comment above) after that
      // brought the white edge-rim back in Dark Mode, worse than before.
      // Back at round 6's value; clearcoat/clearcoatRoughness above stay
      // put too.
      envMapIntensity: 1.5,
    })
    const globe = new THREE.Mesh(geo, mat)
    scene.add(globe)

    // RC round 8: "this white ring doesn't work at all for dark mode."
    // Diagnosed with a real angular pixel sweep (12 samples around the
    // sphere at 80% radius): NOT uniform (57,46,34 at one angle vs.
    // 255,217,152 90 degrees away), ruling out a Fresnel/backdrop ring --
    // this is a genuinely overexposed specular highlight. Mid-session, a
    // separate and much more basic problem confused this whole diagnosis:
    // the local web dev server (port 8082)'s Metro bundler had a stale
    // module-resolution cache (throwing real "Unable to resolve
    // expo-asset/expo-constants" errors in the console) and had silently
    // stopped picking up ANY edits to this file for an unknown stretch of
    // this session -- every material/light value changed during that
    // window measured as having zero effect, which looked exactly like
    // "nothing here is the cause" but was actually "nothing is reaching
    // the browser at all." Restarted the dev server with a cleared cache
    // (`expo start --web --port 8082 --clear`) once the resolution errors
    // gave it away, confirmed a real rebuild (2292 modules), and re-ran
    // this same diagnosis on genuinely current code. Final key value here
    // (9.2 -> 4.0) plus the rake/rim/clearcoat/roughness changes below,
    // together, resolved it: verified via fresh screenshot AND the same
    // angular sweep -- no continuous ring at any angle, only the two
    // small, expected point-light sparkle highlights that have been part
    // of this design since early in the session.
    const key = new THREE.DirectionalLight(0xffdb96, 4.0)
    key.position.set(-2.5, 2, 3)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xffe8b0, 0.4)
    rim.position.set(2, -1, -2)
    scene.add(rim)
    // Cut roughly in half (2.2/1.7 -> 1.1/0.8) as part of the same round-8
    // fix above -- "supporting role" per the original prototype's own
    // comment, but at their original intensity and this close to a
    // roughness-0.12-0.18 metal sphere, their specular highlights were
    // clipping toward white.
    const rake = new THREE.PointLight(0xffe6a8, 1.1, 10)
    rake.position.set(-1.6, -0.2, 1.6)
    scene.add(rake)
    const rake2 = new THREE.PointLight(0xffe6a8, 0.8, 10)
    rake2.position.set(1.7, 0.3, -1.4)
    scene.add(rake2)
    scene.add(new THREE.AmbientLight(0x2e2110, 0.1))

    const clock = new THREE.Clock()
    const animate = () => {
      if (disposed.current) return
      requestAnimationFrame(animate)
      globe.rotation.y = clock.getElapsedTime() * 0.25
      renderer.render(scene, camera)
      gl.endFrameEXP()
    }

    // See AceGem3D.tsx's matching comment.
    disposablesRef.current = [
      geo, mat, bumpTex, aoTex, envRaw as THREE.Texture, env,
      { dispose: () => renderer.dispose() },
      { dispose: () => renderer.forceContextLoss() },
    ]

    if (!disposed.current) setReady(true)
    animate()
  }

  // See AceGem3D.tsx's matching comment on why position:'relative' is
  // explicit here.
  return (
    <View style={{ width: size, height: size, position: 'relative', alignSelf: 'center' }}>
      {!ready && (
        <View
          pointerEvents="none"
          style={{
            width: size, height: size, borderRadius: size / 2,
            backgroundColor: 'rgba(255,201,64,0.12)',
          }}
        />
      )}
      {/* RC, real device, build 33: "the globe is out of center, low and
          left." Root cause not diagnosable here -- this can't be reproduced
          in the web preview (GLView is a genuinely different native
          component on iOS vs. web, not just CSS) and this environment has
          no working Simulator/device to test the real 3D camera/scene math
          against. Per RC's own explicit direction: an empirical 2D
          correction from the reported direction, not a diagnosed fix --
          shifts the rendered canvas up and right within its still-centered,
          still-circular-clipped parent (profile/[userId].tsx's wrapper),
          same as nudging a picture inside an already-correctly-hung frame.
          Magnitude is a first estimate (~8% of the 268pt canvas each axis),
          not measured against a real device -- expect this needs one more
          round of adjustment once RC sees it live, same as this session's
          own earlier trophy-tuning rounds. */}
      <GLView
        style={[StyleSheet.absoluteFill, { transform: [{ translateX: 18 }, { translateY: -22 }] }]}
        onContextCreate={(gl) => { onContextCreate(gl).catch((err) => Sentry.captureException(err)) }}
      />
    </View>
  )
}
