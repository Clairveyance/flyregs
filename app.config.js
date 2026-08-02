// Dynamic override layer on top of app.json -- Expo merges the two
// automatically (app.json's "expo" object is passed in as `config`), so
// every field not touched here (icons, plugins, intentFilters, etc.) keeps
// coming from app.json unchanged. See
// https://docs.expo.dev/tutorial/eas/multiple-app-variants/.
//
// Exists to fix a real collision: eas.json's "development" build profile
// used to inherit app.json's production bundleIdentifier/package verbatim,
// so an internal-distribution dev-client build and the real TestFlight app
// were, to iOS, "the same app" -- installing the dev build was blocked with
// "FlyRegs is already installed on this device" (confirmed live 2026-08-02).
// APP_VARIANT is set per-profile in eas.json's own "env" block; unset (e.g.
// plain `npx expo start`, or no APP_VARIANT at all) resolves to production.
const IS_DEV = process.env.APP_VARIANT === 'development'
const IS_PREVIEW = process.env.APP_VARIANT === 'preview'

function uniqueIdentifier() {
  if (IS_DEV) return 'com.clairveyance.flyregs.dev'
  if (IS_PREVIEW) return 'com.clairveyance.flyregs.preview'
  return 'com.clairveyance.flyregs'
}

function appName() {
  if (IS_DEV) return 'FlyRegs (Dev)'
  if (IS_PREVIEW) return 'FlyRegs (Preview)'
  return 'FlyRegs'
}

module.exports = ({ config }) => ({
  ...config,
  name: appName(),
  ios: {
    ...config.ios,
    bundleIdentifier: uniqueIdentifier(),
  },
  android: {
    ...config.android,
    package: uniqueIdentifier(),
  },
})
