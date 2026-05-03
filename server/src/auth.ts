import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { username } from "better-auth/plugins";
import { prisma } from "./db.js";
import { sendEmail } from "./lib/mailer.js";

// FRONTEND_ORIGIN may be a comma-separated list (game frontend +
// admin dashboard). Trusted-origins also needs each value individually.
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BACKEND_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:8787";
const DEV_SECRET = "dev-secret-change-me-32-bytes-long";
const SECRET = process.env.BETTER_AUTH_SECRET ?? DEV_SECRET;
// Refuse to boot in production with the default dev secret. Anyone who
// guessed it could forge session cookies — this happens silently if the
// env var isn't set, so we surface it loudly instead.
if (process.env.NODE_ENV === "production" && SECRET === DEV_SECRET) {
  console.error(
    "[auth] FATAL: BETTER_AUTH_SECRET is unset (or still the dev default) " +
    "in production. Set it to a 32+ byte random string."
  );
  process.exit(1);
}

const googleConfigured =
  !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: SECRET,
  baseURL: BACKEND_URL,
  trustedOrigins: FRONTEND_ORIGINS,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    autoSignIn: true,
    minPasswordLength: 8,
    // Password reset: Better Auth issues a one-shot token + assembles a
    // URL pointing at the frontend's reset page. We deliver the URL via
    // email. Token TTL is 1 hour — long enough for a slow user, short
    // enough that a leaked link from inbox spam-shared screenshots
    // expires before it can be abused.
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      // user.username isn't on Better Auth's typed user (it comes from
      // the `username` plugin and lives at the DB layer). Fall back to
      // name → email-local-part → "trainer" so the greeting always
      // resolves to something human.
      const greeting =
        user.name?.trim() ||
        user.email.split("@")[0] ||
        "trainer";
      await sendEmail({
        to: user.email,
        subject: "Reset your Pokémon Idle password",
        text:
          `Hi ${greeting},\n\n` +
          `We received a request to reset your password. Click the link below to choose a new one. ` +
          `The link expires in 1 hour.\n\n` +
          `${url}\n\n` +
          `If you didn't request this, you can safely ignore this email — your password won't change.\n\n` +
          `— Pokémon Idle`,
        html:
          `<p>Hi ${escapeHtml(greeting)},</p>` +
          `<p>We received a request to reset your password. ` +
          `<a href="${url}">Click here</a> to choose a new one. ` +
          `The link expires in 1 hour.</p>` +
          `<p>If you didn't request this, you can safely ignore this email — your password won't change.</p>` +
          `<p>— Pokémon Idle</p>`,
      });
    },
  },
  socialProviders: googleConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      }
    : {},
  plugins: [
    // Adds username field on signup + sign-in by username support.
    // ASCII-only regex blocks Cyrillic / Greek homoglyph impersonation
    // (e.g. signing up as Latin-`a`-bot vs. Cyrillic-`а`-bot looks
    // identical and can trick chat readers into trusting the wrong user).
    // Match the same character class the signup form already enforces
    // client-side, so the two layers agree.
    username({
      minUsernameLength: 3,
      maxUsernameLength: 20,
      usernameValidator: (u) => /^[a-zA-Z0-9_]{3,20}$/.test(u),
    }),
  ],
  advanced: {
    cookiePrefix: "pkmn",
    crossSubDomainCookies: { enabled: false },
    defaultCookieAttributes: {
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
    },
  },
});

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

// Minimal HTML escape — only used for transactional email bodies where
// we splice user-controlled fields (display name) into HTML. Safer than
// pulling in a dependency for two-three callsites.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
