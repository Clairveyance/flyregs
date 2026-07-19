// Sends the "Welcome to FlyRegs" onboarding email, once, right after a new
// account's email gets confirmed. Triggered by a Postgres trigger on
// auth.users (confirmed_at going from null to non-null) via pg_net -- NOT
// fired client-side, so it still goes out even if someone confirms and
// doesn't reopen the app right away, and can't accidentally double-fire from
// a retried client call.
//
// Configure as the trigger's target:
//   URL: https://<project-ref>.supabase.co/functions/v1/send-welcome-email
//   Authorization header value: the WELCOME_EMAIL_SECRET set on this function
//
// No third-party imports -- plain fetch to Resend's API, to avoid remote
// module resolution at cold-start (esm.sh/jsr imports caused BOOT_ERROR
// when deployed via the Management API's single-file deploy endpoint).

const WELCOME_HTML = `<div style="margin:0; padding:0; background-color:#07111E;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#07111E; padding:32px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#0C1826; border-radius:16px; border:1px solid #1A2C42;">

<tr><td align="center" style="padding:20px 32px 0 32px;">
<img src="https://flyregs.com/assets/app-icon-glow-v3.png" width="320" height="160" alt="FlyRegs" style="display:block;">
</td></tr>

<tr><td align="center" style="padding:16px 32px 0 32px;">
<img src="https://flyregs.com/assets/wordmark-gold.png" width="140" alt="FlyRegs" style="display:block;">
</td></tr>

<tr><td align="center" style="padding:28px 32px 0 32px; font-family:Helvetica,Arial,sans-serif;">
<span style="font-size:20px; font-weight:700; color:#EDF2FF;">Welcome to FlyRegs!</span>
</td></tr>

<tr><td align="center" style="padding:16px 36px 0 36px; font-family:Helvetica,Arial,sans-serif;">
<span style="font-size:15px; line-height:23px; color:#9DB7CE;">Thank you for joining our community &mdash; we're honored to have you here. We're striving to make all aviation regulations as simple, easy, and even fun to access as possible &mdash; for pilots, mechanics, operators, and everyone in between.</span>
</td></tr>

<tr><td align="center" style="padding:16px 36px 0 36px; font-family:Helvetica,Arial,sans-serif;">
<span style="font-size:15px; line-height:23px; color:#9DB7CE;">As you explore the app, if there's anything we can do to make it more useful for you, please reach out and let us know.</span>
</td></tr>

<tr><td align="center" style="padding:24px 32px 8px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0">
<tr><td align="center" bgcolor="#4B8EF5" style="border-radius:12px;">
<a href="https://flyregs.com" target="_blank" style="display:inline-block; padding:15px 36px; font-family:Helvetica,Arial,sans-serif; font-size:16px; font-weight:700; color:#FFFFFF; text-decoration:none; border-radius:12px;">Open FlyRegs</a>
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:24px 32px 8px 32px; font-family:Helvetica,Arial,sans-serif;">
<span style="font-size:15px; color:#C6A224; font-weight:600;">Blue skies,</span><br>
<span style="font-size:14px; color:#9DB7CE;">The FlyRegs Team</span>
</td></tr>

<tr><td align="center" style="padding:20px 32px 36px 32px; font-family:Helvetica,Arial,sans-serif;">
<span style="font-size:12.5px; line-height:18px; color:#537A99;">Questions or feedback? Just reply to this email, or send us a message from within the app &mdash; we read every message.</span>
</td></tr>

</table>
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%;">
<tr><td align="center" style="padding:20px 32px 0 32px; font-family:Helvetica,Arial,sans-serif;">
<span style="font-size:12px; color:#537A99;">FlyRegs &middot; The complete FAA Advisory Circular reference</span>
</td></tr>
</table>
</td></tr>
</table>
</div>`

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const expectedAuth = Deno.env.get('WELCOME_EMAIL_SECRET')
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

  const email = body?.email
  if (!email || typeof email !== 'string') {
    return new Response('Bad request', { status: 400 })
  }

  const resendKey = Deno.env.get('RESEND_API_KEY')!
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: '"FlyRegs" <noreply@flyregs.com>',
      to: [email],
      reply_to: 'support@flyregs.com',
      subject: 'Welcome to FlyRegs!',
      html: WELCOME_HTML,
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    return new Response(`Resend error: ${errText}`, { status: 502 })
  }

  return new Response('ok', { status: 200 })
})
