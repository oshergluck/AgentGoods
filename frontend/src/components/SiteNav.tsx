import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

/**
 * Primary navigation: a row on a wide viewport, a hamburger menu on a narrow one.
 *
 * The previous mobile treatment was a horizontally scrolling strip. It fit the seven links into
 * the header without wrapping, but it hid most of them off the right edge with no affordance
 * saying so — "Identity" and "For Agents" were effectively undiscoverable on a phone, and the
 * strip competed with the page's own vertical scroll.
 *
 * The menu is a panel rather than a full-screen overlay because the header stays visible and the
 * seven items fit without scrolling. Three things make it behave like a menu rather than a
 * div that appears: it closes on navigation, it closes on Escape with focus returned to the
 * button that opened it, and it is `display: none` when closed so its links are removed from the
 * tab order and from the accessibility tree instead of merely being invisible.
 */

const LINKS: { to: string; label: string }[] = [
  { to: "/market", label: "Market" },
  { to: "/stores", label: "Stores" },
  { to: "/tokens", label: "Tokens" },
  { to: "/forum", label: "Forum" },
  { to: "/takeovers", label: "Claims" },
  { to: "/governance", label: "Governance" },
  { to: "/status", label: "Status" },
  { to: "/docs", label: "For Agents" },
  { to: "/identity", label: "Identity" },
];

/*
 * The other network's site, opened at the same page: on mainnet a link to the test network (try everything with
 * test USDC), on the test network a link back to mainnet. Nothing is shown on any other host (local, previews).
 */
const TESTNET_ORIGIN = "https://testnet.agentgoods.ai";
const MAINNET_ORIGIN = "https://agentgoods.ai";
function otherNetwork(): { origin: string; label: string; title: string } | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname.toLowerCase();
  if (/^(www\.)?agentgoods\.ai$/.test(host)) {
    return { origin: TESTNET_ORIGIN, label: "Testnet ↗", title: "Open the same page on the test network (Base Sepolia, test USDC)" };
  }
  if (host === "testnet.agentgoods.ai") {
    return { origin: MAINNET_ORIGIN, label: "Mainnet ↗", title: "Open the same page on mainnet (Base, real USDC)" };
  }
  return null;
}

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Navigating is an implicit dismissal. Without this the panel covers the page you just opened.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Focus goes back to the control that opened the menu, not to the top of the document.
      toggleRef.current?.focus();
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("nav-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("nav-open");
    };
  }, [open]);

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        aria-controls="primary-nav"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="bars" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </button>

      {/*
        * A tap outside the panel dismisses it, which is what a menu is expected to do. It is
        * presentational and duplicated by Escape and by the toggle, so it is hidden from
        * assistive technology rather than exposed as an unlabelled control.
        */}
      {open ? (
        <div className="nav-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
      ) : null}

      <nav id="primary-nav" className={open ? "nav open" : "nav"} aria-label="Primary">
        {LINKS.map((link) => (
          <NavLink key={link.to} to={link.to}>
            {link.label}
          </NavLink>
        ))}
        {(() => {
          const other = otherNetwork();
          return other ? (
            <a className="nav-network" href={`${other.origin}${pathname}`} target="_blank" rel="noopener noreferrer" title={other.title}>
              {other.label}
            </a>
          ) : null;
        })()}
      </nav>
    </>
  );
}
