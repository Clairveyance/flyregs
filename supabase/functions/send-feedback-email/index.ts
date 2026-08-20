// Relays a feedback_submissions row to support@flyregs.com via Resend.
// Triggered by a Postgres trigger on feedback_submissions (AFTER INSERT) via
// pg_net -- server-side, NOT dependent on the submitting device's own mail
// setup, unlike the old client-only path.
//
// Why this exists: Send Feedback's old implementation (expo-mail-composer,
// falling back to a raw Linking.openURL('mailto:...')) has no way to
// guarantee an email actually leaves the user's device. On web,
// MailComposer.isAvailableAsync() always returns true and composeAsync()
// only does window.open('mailto:...') -- it can never report SENT, only
// UNDETERMINED. On native, MFMailComposeViewController.canSendMail() (what
// isAvailableAsync() wraps) is false for any device with no account added
// to Settings > Mail -- common for users who only use a third-party mail
// app -- which falls through to the same unreliable raw mailto: handoff
// (confirmed failing at least once in Sentry: "Unable to open URL:
// mailto:support@flyregs.com", 2026-07-18). None of these failure modes
// leave any trace anywhere -- which is exactly the symptom reported
// 2026-08-10 ("a couple people said they sent bug reports... we haven't
// received their emails"). The fix: the app now writes the feedback
// directly to Supabase first (a real, durable, queryable row -- the message
// is NEVER at the mercy of the user's own device's mail configuration), and
// this function is the server-side relay, independent of the client
// entirely once the row exists.
//
// Configure as the trigger's target:
//   URL: https://<project-ref>.supabase.co/functions/v1/send-feedback-email
//   Authorization header value: the FEEDBACK_EMAIL_SECRET set on this function
//
// No third-party imports -- plain fetch to Resend's API, matching
// send-welcome-email (remote esm.sh/jsr imports caused BOOT_ERROR at
// cold-start via this deploy path).

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const expectedAuth = Deno.env.get('FEEDBACK_EMAIL_SECRET')
  const gotAuth = req.headers.get('authorization')
  if (!expectedAuth || gotAuth !== expectedAuth) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return new Response('Bad request', { status: 400 })
  }

  const { id, category, message, user_email, app_version, platform, attachment_path } = body ?? {}
  if (!id || typeof message !== 'string') {
    return new Response('Bad request', { status: 400 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const markSent = (status: string, error: string | null) =>
    fetch(`${supabaseUrl}/rest/v1/feedback_submissions?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ email_status: status, email_error: error }),
    })

  const resendKey = Deno.env.get('RESEND_API_KEY')!
  const catLabel = { bug: 'Report a bug', idea: 'Suggest a feature', content: 'Content correction', other: 'Something else', aircraft_part: 'Suggest Aircraft or Part' }[category as string] ?? 'Feedback'
  const subject = `FlyRegs — ${catLabel}`
  const html = `<div style="font-family:Helvetica,Arial,sans-serif; font-size:14px; color:#0C1826; white-space:pre-wrap;">${escapeHtml(message)}</div>
<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;">
<div style="font-family:Helvetica,Arial,sans-serif; font-size:12px; color:#666;">
Category: ${escapeHtml(catLabel)}<br>
From: ${escapeHtml(user_email || '(not signed in)')}<br>
App: ${escapeHtml(app_version || '?')} · ${escapeHtml(platform || '?')}<br>
Submission id: ${escapeHtml(id)}
</div>`

  // Attachments live in the private `feedback-attachments` bucket with no
  // client-readable select policy at all (see
  // migrations_feedback_attachment.sql) -- this service_role fetch is the
  // ONLY way the screenshot is ever read back out. Best-effort: a failed
  // fetch here shouldn't block the feedback email itself from sending, so
  // this just falls back to no attachment rather than throwing.
  let resendAttachments: { filename: string; content: string }[] | undefined
  if (attachment_path && typeof attachment_path === 'string') {
    try {
      const objResp = await fetch(
        `${supabaseUrl}/storage/v1/object/feedback-attachments/${attachment_path}`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      )
      if (objResp.ok) {
        const bytes = new Uint8Array(await objResp.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        resendAttachments = [{ filename: attachment_path.split('/').pop() || 'screenshot.jpg', content: btoa(binary) }]
      }
    } catch {
      // Swallow -- see comment above.
    }
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: '"FlyRegs Feedback" <noreply@flyregs.com>',
        to: ['support@flyregs.com'],
        reply_to: user_email && typeof user_email === 'string' ? user_email : undefined,
        subject,
        html,
        attachments: resendAttachments,
      }),
    })

    if (!resp.ok) {
      const errText = await resp.text()
      await markSent('failed', errText.slice(0, 500))
      return new Response(`Resend error: ${errText}`, { status: 502 })
    }

    await markSent('sent', null)
    return new Response('ok', { status: 200 })
  } catch (e) {
    await markSent('failed', String(e).slice(0, 500))
    return new Response(`error: ${e}`, { status: 500 })
  }
})
