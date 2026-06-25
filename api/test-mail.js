// api/test-mail.js  (delete after confirming it works)
import { sendEmail } from "./_mailer.js";

export default async function handler(req, res) {
  try {
    await sendEmail({
      to: process.env.MAIL_SENDER, // send to yourself
      subject: "Graph API test",
      html: "<p>If you're reading this, Microsoft Graph is working ✓</p>",
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
