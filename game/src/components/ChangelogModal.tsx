import { useEffect, useState } from "react";
import { changelog, CURRENT_VERSION, LAST_SEEN_VERSION_KEY } from "../data/changelog";

export function ChangelogModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const seen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
      if (seen !== CURRENT_VERSION) setOpen(true);
    } catch {
      // localStorage unavailable; just don't show
    }
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(LAST_SEEN_VERSION_KEY, CURRENT_VERSION);
    } catch {
      /* noop */
    }
    setOpen(false);
  }

  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={dismiss}>
      <div className="modal changelog" onClick={(e) => e.stopPropagation()}>
        <header className="info-head">
          <h2>
            What's new
            <span className="changelog-version-pill">v{CURRENT_VERSION}</span>
          </h2>
          <button className="info-close" onClick={dismiss} aria-label="Close">×</button>
        </header>
        <div className="changelog-body">
          {changelog.map((entry) => (
            <div key={entry.version} className="changelog-entry">
              <h3 className="changelog-entry-head">
                <span className="changelog-version-tag">v{entry.version}</span>
                {entry.subtitle && <span className="dim">{entry.subtitle}</span>}
              </h3>
              {entry.sections.map((sec) => (
                <div key={sec.heading} className="changelog-section">
                  <h4>{sec.heading}</h4>
                  <ul>
                    {sec.items.map((it, i) => (
                      <li key={i}>{it}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
        <footer className="changelog-foot">
          <button className="changelog-dismiss" onClick={dismiss}>Got it</button>
        </footer>
      </div>
    </div>
  );
}
