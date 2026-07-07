import { ProseScreen, ProseSection } from '@/components/ProseScreen'
import { APP_NAME, COMPANY, SUPPORT_EMAIL, LEGAL_UPDATED } from '@/lib/appInfo'

const SECTIONS: ProseSection[] = [
  {
    heading: 'What we collect',
    body: [
      `${APP_NAME} is designed to work without an account. Browsing the Advisory Circular library, searching, and viewing recently opened ACs all happen on your device and require no sign-in.`,
      'If you create an account, we collect your email address to authenticate you. If you turn on AC Update Alerts (Premium), we store a device push token so we can notify you. If you upload a profile picture, it is stored and may be visible to people you share content with. We never sell your data.',
    ],
  },
  {
    heading: 'Notes, bookmarks & on-device data',
    body: [
      'By default, your notes, bookmarks, folders, and recently viewed list are stored privately on this device and are never uploaded to our servers.',
      'If you enable Back up & sync (a Premium feature), your notes, bookmarks, and folders are uploaded to your account so they survive a reinstall and sync across your devices. This data is protected in transit (HTTPS) and at rest, and access is restricted to your account — but it is not end-to-end encrypted, meaning it is technically readable by our infrastructure provider under our data-access controls, the same as most cloud-synced apps. If that distinction matters to you, you can leave Back up & sync off and your notes will stay device-only.',
    ],
  },
  {
    heading: 'Analytics',
    body: [
      `${APP_NAME} does not currently use any analytics or usage-tracking service. We may add basic, anonymous, aggregated usage metrics in the future to improve the app; if we do, this policy will be updated first.`,
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
      'You can request account deletion at any time from Account → Delete Account, which opens a message to our support team. We process deletion requests, removing your email and any synced data from our servers, within 30 days.',
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
