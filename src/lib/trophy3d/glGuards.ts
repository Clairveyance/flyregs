import type { ExpoWebGLRenderingContext } from 'expo-gl'

// expo-gl's native WebGL2 shim is REAL but PARTIAL, not a version-detection
// false positive like the "WebGL 1 is not supported since r163" bug (see
// this project's own gotcha_expo_gl_three_webgl1_guard.md and the matching
// guard in patches/three+0.166.1.patch) -- it's a fixed, small set of
// WebGL2 functions that expo-gl's native side stubs out and unconditionally
// THROWS on the instant anything calls them. Confirmed directly against
// expo-gl's own native source, node_modules/expo-gl/common/EXWebGLMethods.cpp's
// UNIMPL_NATIVE_METHOD list: getBufferSubData, getFramebufferAttachmentParameter,
// getRenderbufferParameter, renderbufferStorageMultisample. three.js's
// current render path for FlyRegs' trophies only reaches the last of those
// (creating a multisampled WebGLRenderTarget), so this guard covers that one
// with a real, safe fallback.
//
// RC, real device, build 33: the Ace diamond trophy (AceGem3D.tsx) crashed
// the app opening the locked-badge popup -- "EXGL: renderbufferStorageMultisample()
// isn't implemented yet!" (confirmed via Sentry stack trace: AceGem3D
// animate -> three render -> renderTransmissionPass -> setupRenderTarget ->
// native renderbufferStorageMultisample). Root cause: MeshPhysicalMaterial's
// transmission:1.0 makes three.js's renderTransmissionPass hardcode
// `samples: 4` on an internal WebGLRenderTarget -- unconditional, the
// instant ANY transmissive material renders a frame. Two fixes landed:
// (1) patches/three+0.166.1.patch changes that hardcoded 4 to 0, so
// three's own code never even calls the native function for THAT specific
// call site (gated on `samples > 0` in three's own setup code); (2) this
// function, a second, general-purpose layer underneath it -- it doesn't
// care WHERE in three.js (or expo-three, or a future three.js version
// bump) a multisampled renderbuffer gets requested, it makes the native
// call itself permanently safe by always dropping the sample count, so ANY
// future code path that tries to create one degrades to a plain
// (non-multisampled) renderbuffer instead of throwing -- structurally, not
// by matching this one error string or this one call site.
//
// This guard was previously inlined ONLY in AceGem3D.tsx, because the
// diamond's transmissive material was what happened to trip call site (1)
// above FIRST. That reasoning was about WHERE the bug was first observed,
// not about what expo-gl actually supports: expo-gl's native
// renderbufferStorageMultisample stub throws for ANY caller, on ANY GL
// context, regardless of which trophy created it. MasterGlobe3D.tsx builds
// its GL context/Renderer through the exact identical expo-gl/expo-three
// stack -- nothing in expo-gl's own capabilities differs between the two
// components. It doesn't hit this today only because its material has no
// `transmission` (so call site (1) never fires for it), which is an
// implicit, fragile invariant, not a real guarantee -- this project's own
// session history shows trophy materials getting re-tuned repeatedly (see
// MasterGlobe3D.tsx's own round 4-8 comments), and any future three.js
// version bump could add another samples>0 render target through a
// completely different, currently-nonexistent code path. Every
// onContextCreate that constructs an expo-three Renderer against an
// expo-gl context should call this before constructing it, not just the
// one that already happened to hit the bug.
export function guardUnsupportedRenderbufferMultisample(gl: ExpoWebGLRenderingContext): void {
  const glAny = gl as any
  if (typeof glAny.renderbufferStorageMultisample === 'function') {
    const plainStorage = gl.renderbufferStorage.bind(gl)
    glAny.renderbufferStorageMultisample = (
      target: number,
      _samples: number,
      internalformat: number,
      width: number,
      height: number
    ) => plainStorage(target, internalformat, width, height)
  }
}
