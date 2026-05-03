// Email delivery — used by Better Auth's password-reset flow plus any
// future transactional sends (verification, account-changes notices).
//
// Two modes:
//   - SMTP mode (production): SMTP_HOST set; uses nodemailer to send via
//     the configured relay. Works with any SMTP provider — Resend's
//     SMTP gateway, SendGrid, Postmark, AWS SES, Gmail, etc.
//   - Dev mode (no SMTP_HOST): logs the email body to the server log so
//     local testing doesn't require a real mailbox. Reset links can be
//     copy-pasted from the log.
//
// `EMAIL_FROM` is the visible From: address. Most providers require
// this to match a verified sender / domain — set it accordingly.

import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger.js";

let cachedTransport: Transporter | null = null;
let smtpReady = false;

function getTransport(): Transporter | null {
  if (smtpReady) return cachedTransport;
  smtpReady = true;
  const host = process.env.SMTP_HOST;
  if (!host) return null;

  const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  cachedTransport = nodemailer.createTransport({
    host,
    port,
    // Port 465 is implicit-TLS; 587 is STARTTLS-on-cleartext. Anything
    // else is provider-specific — defer to nodemailer defaults.
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
  // Verify connection on first use so config errors surface in logs
  // immediately instead of at every send attempt. Don't block on this —
  // failures are logged and the next send will retry.
  cachedTransport.verify().then(
    () => logger.info("[mailer] smtp transport verified", { host, port }),
    (err) => logger.warn("[mailer] smtp verify failed", { host, port, message: (err as Error).message })
  );
  return cachedTransport;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const from = process.env.EMAIL_FROM ?? "no-reply@pokeidle.local";
  const transport = getTransport();
  if (!transport) {
    // Dev fallback — surface the full body so a developer can grab
    // reset links from the log without setting up SMTP.
    logger.info("[mailer] DEV MODE — email would be sent", {
      from,
      to: msg.to,
      subject: msg.subject,
      body: msg.text,
    });
    return;
  }
  try {
    await transport.sendMail({ from, ...msg });
    logger.info("[mailer] sent", { to: msg.to, subject: msg.subject });
  } catch (err) {
    logger.error("[mailer] send failed", {
      to: msg.to,
      subject: msg.subject,
      message: (err as Error).message,
    });
    throw err;
  }
}
