// api/_mailer.js
let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
      }),
    }
  );
  if (!res.ok) throw new Error(`Token fetch failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return _tokenCache.token;
}

export async function sendEmail({ to, subject, html }) {
  const token = await getAccessToken();
  const sender = process.env.MAIL_SENDER;
  const recipients = (Array.isArray(to) ? to : String(to).split(','))
    .map(a => a.trim()).filter(Boolean)
    .map(address => ({ emailAddress: { address } }));

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${sender}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: recipients },
        saveToSentItems: true,
      }),
    }
  );
  if (res.status !== 202) throw new Error(`Graph sendMail failed (${res.status}): ${await res.text()}`);
}
