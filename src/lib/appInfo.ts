// Centralized app metadata + external endpoints.
// Update these before App Store submission.

import Constants from 'expo-constants'

export const APP_NAME = 'FlyRegs'
export const COMPANY = 'Clairveyance'
export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0'

// Build number (iOS) / versionCode (Android) when available
export const BUILD_NUMBER =
  Constants.expoConfig?.ios?.buildNumber ??
  String(Constants.expoConfig?.android?.versionCode ?? '1')

// Contact + store links
export const SUPPORT_EMAIL = 'support@flyregs.com'
export const WEBSITE_URL = 'https://flyregs.com'
export const APP_STORE_ID = '6785706782'
export const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`
export const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.clairveyance.flyregs'

// "Last updated" date shown on legal screens
export const LEGAL_UPDATED = 'June 2026'
