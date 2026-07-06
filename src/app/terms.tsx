import { ProseScreen, ProseSection } from '@/components/ProseScreen'
import { APP_NAME, COMPANY, SUPPORT_EMAIL, LEGAL_UPDATED } from '@/lib/appInfo'

const SECTIONS: ProseSection[] = [
  {
    heading: 'Acceptance',
    body: [
      `By downloading or using ${APP_NAME}, you agree to these Terms of Use. If you do not agree, do not use the app.`,
    ],
  },
  {
    heading: 'Not official FAA guidance',
    body: [
      `${APP_NAME} is an independent reference tool and is not affiliated with, endorsed by, or sponsored by the U.S. Federal Aviation Administration.`,
      'Advisory Circulars provide guidance and are not, by themselves, regulations. Always confirm currency and applicability against the official source at faa.gov before relying on any material for operational, maintenance, or certification decisions. The app is provided for convenience and informational purposes only.',
    ],
  },
  {
    heading: 'Subscriptions & billing',
    body: [
      'Some features require a paid subscription. Subscriptions are billed through your Apple or Google account and renew automatically unless cancelled at least 24 hours before the end of the current period.',
      'You can manage or cancel a subscription in your App Store or Google Play account settings. Prices are shown in the app and may vary by region.',
    ],
  },
  {
    heading: 'Acceptable use',
    body: [
      'You agree not to misuse the app — including reverse-engineering it, reselling access, or attempting to disrupt its operation. Your account is for your personal use.',
    ],
  },
  {
    heading: 'Disclaimer & liability',
    body: [
      `${APP_NAME} is provided "as is" without warranties of any kind. To the maximum extent permitted by law, ${COMPANY} is not liable for any loss or damage arising from your use of the app or reliance on its content.`,
    ],
  },
  {
    heading: 'Changes',
    body: [
      'We may update these terms from time to time. Continued use after an update constitutes acceptance of the revised terms.',
      `Questions? Email ${SUPPORT_EMAIL}.`,
    ],
  },
]

export default function TermsScreen() {
  return (
    <ProseScreen
      title="Terms of Use"
      updated={LEGAL_UPDATED}
      intro={`These terms govern your use of ${APP_NAME}, operated by ${COMPANY}. This is a plain-language summary and is not a substitute for legal advice.`}
      sections={SECTIONS}
    />
  )
}
