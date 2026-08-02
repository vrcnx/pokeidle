import { useEffect } from "react";

/**
 * Publishes the platform's classic-scrollbar width as `--scrollbar-w` on the
 * document root.
 *
 * The topbar and the page below it are one column and must share a right
 * edge, but only the page scrolls — so the page loses ~10-15px to its
 * scrollbar and the bar does not. The bar reserves the difference.
 *
 * Measured rather than assumed: 15px on Windows, 17px on older Linux themes,
 * 0 on macOS overlay scrollbars and on any browser using overlay scrollbars.
 * Hardcoding any of those numbers is wrong on the other platforms, and
 * hardcoding 0 is wrong on the one this dashboard is actually used from.
 *
 * Once at mount. The value cannot change without restarting the browser.
 */
export function useScrollbarWidthVar(): void {
  useEffect(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll";
    document.body.appendChild(probe);
    const w = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    document.documentElement.style.setProperty("--scrollbar-w", `${w}px`);
  }, []);
}
