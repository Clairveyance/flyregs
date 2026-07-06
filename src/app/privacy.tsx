import { ProseScreen, ProseSection } from '@/components/ProseScreen'
import { APP_NAME, COMPANY, SUPPORT_EMAIL, LEGAL_UPDATED } from '@/lib/appInfo'

const SECTIONS: ProseSection[] = [
  {
    heading: 'What we collect',
    body: [
      `${APP_NAME} is designed to work without an account. Browsing the Advisory Circular library, searching, and viewing recently opened ACs all happen on your device and require no sign-in.`,
      'If you create an account, we collect your email address to authenticate you and to sync your bookmarks. We never sell your data.',
    ],
  },
  {
    heading: 'Notes & on-device data',
    body: [
      'By default, your notes, recently viewed list, and appearance settings are stored privately on this device and are never uploaded to our servers.',
      'If you enable Back up & sync (a Premium feature), your notes are stored end-to-end encrypted in your account so they survive a reinstall and sync across your devices. Because they are encrypted on your device before upload, we cannot read them.',
    ],
  },
  {
    heading: 'Analytics',
    body: [
      'We collect anonymous, aggregated usage metrics (for example, which screens are opened) to improve the app. These metrics are not tied to your identity and never include the contents of your notes or searches.',
    ],
  },
  {
    heading: 'Subscriptions',
    body: [
      'Purchases are processed by Apple or Google. We receive a subscription status (active or not) from the app store and from our payments provider, but we never receive your full payment details.',
    ],
  },
  {
    heading: 'Source content',
    body: [
      'Advisory Circular text and PDFs are published by the U.S. Federal Aviation Administration and are in the public domain. FlyRegs organizes and presents this material but does not alter the official content.',
    ],
  },
  {
    heading: 'Your choices',
    body: [
      'You can delete your account at any time from Account → Delete Account, which removes your email and any synced data from our servers.',
      `Questions about your privacy? Email ${SUPPORT_EMAIL}.`,
    ],
  },
]

export default function PrivacyScreen() {
  return (
    <ProseScreen
      title="Privacy Policy"
      updated={LEGAL_UPDATED}
      intro={`This policy explains what ${APP_NAME}, operated by ${COMPANY}, collects and how it is used. This is a plain-language summary and is not a substitute for legal advice.`}
      sections={SECTIONS}
    />
  )
}
