// Email delivery via Resend's HTTP API. Two env vars and you're done:
//   RESEND_API_KEY  — your `re_…` key from resend.com/api-keys
//   EMAIL_FROM      — verified sender, e.g. "Pokémon Idle <no-reply@pokeidle.com>"
//
// In dev you can leave RESEND_API_KEY blank and emails will be logged
// to the server log instead of sent. Reset links are right there in
// the console for local testing.

import { Resend } from "resend";
import { logger } from "./logger.js";

let cachedClient: Resend | null = null;
function getClient(): Resend | null {
  if (cachedClient) return cachedClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  cachedClient = new Resend(key);
  return cachedClient;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const from = process.env.EMAIL_FROM ?? "Pokémon Idle <onboarding@resend.dev>";
  const client = getClient();
  if (!client) {
    // Dev fallback — surface the full body so a developer can grab
    // reset links from the log without setting up Resend.
    logger.info("[mailer] DEV MODE — RESEND_API_KEY unset, email not sent", {
      from,
      to: msg.to,
      subject: msg.subject,
      body: msg.text,
    });
    return;
  }
  const res = await client.emails.send({
    from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  if (res.error) {
    logger.error("[mailer] resend send failed", {
      to: msg.to,
      subject: msg.subject,
      error: res.error,
    });
    throw new Error(res.error.message);
  }
  logger.info("[mailer] sent", { to: msg.to, subject: msg.subject, id: res.data?.id });
}
