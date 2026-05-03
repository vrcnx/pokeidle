import { useEffect, useState } from "react";
import { useModalEnter } from "../utils/animate";

// Terms / Privacy / Disclaimer modal. One imperative open API
// (`openLegal(tab)`) drives a tabbed dialog used both during signup
// (linked from the consent checkbox) and from the running app's
// footer / settings menu.
//
// All three tabs explicitly state this is an unaffiliated, non-profit
// fan project and that no copyrighted Pokémon assets are stored on the
// server. Sprites are loaded from third-party CDN URLs at runtime.

export type LegalTab = "terms" | "privacy" | "disclaimer";

let _open: LegalTab | null = null;
const _listeners = new Set<(t: LegalTab | null) => void>();

export function openLegal(tab: LegalTab = "terms") {
  _open = tab;
  for (const fn of _listeners) fn(tab);
}
export function closeLegal() {
  _open = null;
  for (const fn of _listeners) fn(null);
}
function useLegalTab(): LegalTab | null {
  const [t, setT] = useState<LegalTab | null>(_open);
  useEffect(() => {
    _listeners.add(setT);
    return () => { _listeners.delete(setT); };
  }, []);
  return t;
}

export function LegalModal() {
  const tab = useLegalTab();
  if (!tab) return null;
  return (
    <div className="modal-overlay" onClick={closeLegal}>
      <LegalDialog initialTab={tab} />
    </div>
  );
}

function LegalDialog({ initialTab }: { initialTab: LegalTab }) {
  const dialogRef = useModalEnter(".g-card");
  const [tab, setTab] = useState<LegalTab>(initialTab);
  return (
    <div
      ref={dialogRef}
      className="g-modal legal-modal"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Legal"
    >
      <header className="g-modal-head">
        <h2>Legal</h2>
        <button className="g-modal-close" onClick={closeLegal} aria-label="Close">×</button>
      </header>
      <div className="legal-tabs">
        <button
          className={`legal-tab ${tab === "terms" ? "active" : ""}`}
          onClick={() => setTab("terms")}
        >Terms of Service</button>
        <button
          className={`legal-tab ${tab === "privacy" ? "active" : ""}`}
          onClick={() => setTab("privacy")}
        >Privacy</button>
        <button
          className={`legal-tab ${tab === "disclaimer" ? "active" : ""}`}
          onClick={() => setTab("disclaimer")}
        >Fan-Game Disclaimer</button>
      </div>

      <div className="g-modal-body legal-body">
        {tab === "terms" && <TermsContent />}
        {tab === "privacy" && <PrivacyContent />}
        {tab === "disclaimer" && <DisclaimerContent />}
      </div>

      <footer className="g-modal-foot">
        <span className="dim small" style={{ flex: 1 }}>
          Last updated: {LAST_UPDATED}
        </span>
        <button className="g-btn-primary" onClick={closeLegal}>Close</button>
      </footer>
    </div>
  );
}

const LAST_UPDATED = "May 2026";

function TermsContent() {
  return (
    <section className="g-card g-card-full legal-section">
      <h3>Terms of Service</h3>
      <p>
        By creating an account or using this site (the "Service"), you
        agree to the terms below. If you do not agree, please don't use
        the Service.
      </p>
      <h4>What this is</h4>
      <p>
        This is a free, non-commercial fan project. We do not sell
        anything, run ads, or accept donations through the Service. There
        is no in-game currency that maps to real money. The Service is
        provided "as is" with no warranty of any kind.
      </p>
      <h4>Your account</h4>
      <ul>
        <li>You must be old enough to consent to processing of your
            email under the laws of your jurisdiction (typically 13+, or
            16+ in the EU). If you're not, please don't sign up.</li>
        <li>Keep your password to yourself. You're responsible for
            activity under your account.</li>
        <li>One active session per account is enforced — signing in
            elsewhere will sign your other sessions out.</li>
        <li>Don't use the Service to harass, spam, scrape, or attack
            other users or our infrastructure.</li>
      </ul>
      <h4>Game state and saves</h4>
      <p>
        We sync your save (party, box, inventory, progress) to the
        server so you can play across devices. Saves are validated for
        plausibility — accounts that submit obviously tampered saves may
        be reset or terminated without notice.
      </p>
      <h4>Fan-game IP notice</h4>
      <p>
        All Pokémon names, sprites, type icons, and related trademarks
        are the property of Nintendo, Game Freak, and The Pokémon
        Company. We are not affiliated with, endorsed by, or sponsored
        by any of those entities. See the <em>Fan-Game Disclaimer</em>{" "}
        tab for the full notice — it's part of these terms.
      </p>
      <h4>Termination</h4>
      <p>
        You can delete your account at any time by emailing us. We can
        suspend or terminate accounts that violate these terms or that
        receive a credible takedown request from a rights-holder. If the
        project itself is asked to shut down by a rights-holder, we will
        comply.
      </p>
      <h4>Changes</h4>
      <p>
        We may update these terms; the "Last updated" date at the bottom
        of this dialog reflects the current version. Continued use after
        an update means you accept the new version.
      </p>
    </section>
  );
}

function PrivacyContent() {
  return (
    <section className="g-card g-card-full legal-section">
      <h3>Privacy</h3>
      <p>
        Short version: we keep the minimum data needed to run the
        account and the game. We don't sell your data or show you ads.
      </p>
      <h4>What we store</h4>
      <ul>
        <li><strong>Account:</strong> email, username, display name,
            hashed password (or a Google-account identifier if you sign
            in with Google).</li>
        <li><strong>Save data:</strong> your party, box, inventory,
            badges, dex progress, in-game money, and similar gameplay
            state.</li>
        <li><strong>Session metadata:</strong> session tokens, last-seen
            timestamps, and basic socket-connection info while you're
            online.</li>
        <li><strong>Chat messages</strong> you send in the in-game
            chat are stored on the server so other players can see
            them.</li>
      </ul>
      <h4>What we do <em>not</em> store</h4>
      <ul>
        <li>We do not store any copyrighted Pokémon sprites, audio, or
            other game assets on our servers. Sprites are loaded at
            runtime from public third-party CDN URLs.</li>
        <li>We do not store payment information — there are no
            payments.</li>
        <li>We do not collect device fingerprints, advertising IDs, or
            third-party tracking cookies.</li>
      </ul>
      <h4>Where it lives</h4>
      <p>
        The database is hosted on Railway (Postgres). The site itself is
        served from a CDN. If you sign in with Google, Google sees the
        sign-in event per their own privacy policy.
      </p>
      <h4>Your choices</h4>
      <ul>
        <li>You can request a copy of your data, or have your account
            deleted, by emailing us. Deletion removes your account row
            and save data; chat messages you've sent may be retained as
            "[deleted user]" so other players' transcripts still make
            sense.</li>
        <li>Don't put anything sensitive in chat or in your username —
            it's visible to other players.</li>
      </ul>
      <h4>Children</h4>
      <p>
        The Service is not directed at children under the age required
        by your local law to consent to data processing. If you believe
        a child has signed up, contact us and we'll remove the account.
      </p>
    </section>
  );
}

function DisclaimerContent() {
  return (
    <section className="g-card g-card-full legal-section">
      <h3>Fan-Game Disclaimer</h3>
      <p>
        <strong>This is an unofficial fan project.</strong> It is not
        affiliated with, endorsed by, sponsored by, or otherwise
        connected to Nintendo, Game Freak, Creatures Inc., or The
        Pokémon Company International (collectively, the "Pokémon
        rights-holders").
      </p>
      <p>
        Pokémon, Pokémon character names, Pokémon sprites, type icons,
        trainer-class names, region names, and all related properties
        are trademarks and copyrights of the Pokémon rights-holders.
        They are used here non-commercially in a transformative,
        fan-built browser game purely for entertainment.
      </p>
      <h4>No profit</h4>
      <p>
        We do not charge for access, sell anything, run advertising, or
        accept donations through the Service. There is no virtual
        currency that maps to real money. If a hosting cost is ever
        offset by donations, that will be disclosed clearly here and
        will not change the non-commercial nature of the project.
      </p>
      <h4>No assets stored on the server</h4>
      <p>
        We do not host or store copyrighted Pokémon sprites, audio,
        music, or other proprietary assets on our servers. The client
        loads sprites at runtime from public third-party CDN URLs that
        already host those images.
      </p>
      <h4>Takedowns</h4>
      <p>
        If you are a Pokémon rights-holder (or their authorized
        representative) and you would like content removed or the
        project shut down, please email us — we will comply promptly. No
        notice or formality is required.
      </p>
      <p className="dim small">
        "Pokémon" and "Pokémon character names" are trademarks of
        Nintendo. © Nintendo / Game Freak / Creatures Inc. / The Pokémon
        Company. All rights belong to their respective owners.
      </p>
    </section>
  );
}
