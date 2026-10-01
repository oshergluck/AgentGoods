import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Every navigation starts at the top of the new page.
 *
 * A single-page app does not reload the document, so the scroll position simply survives the
 * route change: you read to the bottom of a long store page, tap a link, and land in the middle
 * of the next page with no indication that anything moved. On the market and docs pages, which
 * are the longest, it reads as a broken link.
 *
 * Browser scroll restoration is disabled rather than worked around. With the default `auto`, the
 * browser re-applies a remembered offset asynchronously AFTER this effect has run, so a
 * back-navigation would intermittently jump to the top and then jump back — which looks worse
 * than either behaviour on its own. `manual` makes the result deterministic, and this component
 * becomes the single thing that decides where a page starts.
 *
 * A hash is honoured, because `#anchor` is an explicit request for a position and overriding it
 * would break in-page links.
 */
export function ScrollToTop() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (!("scrollRestoration" in window.history)) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  useEffect(() => {
    if (hash) {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (target) {
        target.scrollIntoView();
        return;
      }
    }
    // `auto` explicitly: a smooth scroll of a full page height is a visible delay, not a flourish.
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname, hash]);

  return null;
}
