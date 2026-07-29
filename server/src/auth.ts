import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { username } from "better-auth/plugins";
import { prisma } from "./db.js";
import { sendEmail } from "./lib/mailer.js";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_RE,
} from "./lib/nameChange.js";

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
    // client-side, so the two layers agree — and now the rename route
    // too, which is why the rule lives in lib/nameChange.ts rather than
    // being spelled out separately in each of the three places.
    username({
      minUsernameLength: USERNAME_MIN_LENGTH,
      maxUsernameLength: USERNAME_MAX_LENGTH,
      usernameValidator: (u) => USERNAME_RE.test(u),
    }),
  ],
  // Account linking — credentials and Google can attach to the same
  // User row when the email matches and the OAuth provider verified the
  // email (Google always does). With this on, a player who signed up
  // with email/password and later clicks "Continue with Google" gets
  // auto-linked instead of a "user already exists" error, and vice
  // versa. `trustedProviders` makes the intent explicit even though
  // emailVerified=true would already let it through.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },
  // Auto-generate a username for OAuth signups. Google doesn't return
  // one and the User table requires it (NOT NULL + unique), so without
  // this hook the OAuth flow blows up with "Argument `username` is
  // missing." Strategy: derive from email local-part, sanitize to the
  // same alphabet the credentials path uses, and append random digits
  // until we land on something free.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const u = user as typeof user & { username?: string; displayUsername?: string };
          if (u.username) return { data: u };
          u.username = await generateUniqueUsername(u.email ?? "");
          if (!u.displayUsername) u.displayUsername = u.username;
          return { data: u };
        },
      },
    },
  },
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

// Derive a free username from an email for OAuth signups. Used by the
// databaseHooks.user.create.before hook so Google/etc. signups have a
// valid username on first write. Strategy: take the local-part, strip
// to the credentials-path alphabet [a-zA-Z0-9_], clamp to 3..16 chars
// (leaves room for collision suffix), then probe the DB for a free
// slot, falling back to base + random 3-digit suffix on conflict.
async function generateUniqueUsername(email: string): Promise<string> {
  const local = email.split("@")[0] ?? "";
  let base = local.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16);
  if (base.length < 3) base = "trainer";

  // Probe a few candidates. The first try is the bare base — works for
  // ~all first-time signups. After that we suffix with random digits;
  // 1000 possibilities × 12 attempts is overkill but cheap.
  for (let i = 0; i < 12; i++) {
    const candidate = i === 0
      ? base
      : `${base.slice(0, 16)}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
    const taken = await prisma.user.findUnique({
      where: { username: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  // Pathological collision case — fall back to random + a UUID-ish
  // tail. Should be effectively impossible to hit in practice.
  return `trainer${Date.now().toString(36)}`;
}
