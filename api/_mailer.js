// api/_mailer.js
let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token fetch failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return _tokenCache.token;
}

/**
 * Send an email via Microsoft Graph API.
 *
 * @param {object} opts
 * @param {string|string[]} opts.to        - Recipient address(es)
 * @param {string}          opts.subject   - Subject line
 * @param {string}          opts.html      - HTML body (preferred)
 * @param {string}          [opts.text]    - Plain-text fallback (optional)
 */
export async function sendEmail({ to, subject, html, text }) {
  const token = await getAccessToken();
  const sender = process.env.MAIL_SENDER;

  const recipients = (Array.isArray(to) ? to : to.split(","))
    .map((addr) => addr.trim())
    .filter(Boolean)
    .map((addr) => ({ emailAddress: { address: addr } }));

  const body = {
    message: {
      subject,
      body: {
        contentType: html ? "HTML" : "Text",
        content: html ?? text ?? "",
      },
      toRecipients: recipients,
    },
    saveToSentItems: true,
  };

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${sender}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  // Graph returns 202 Accepted with no body on success
  if (res.status !== 202) {
    const err = await res.text();
    throw new Error(`Graph sendMail failed (${res.status}): ${err}`);
  }
}
