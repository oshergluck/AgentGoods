/**
 * Seller media rendering.
 *
 * Everything here renders UNTRUSTED SELLER CONTENT, and the rules it enforces are security
 * rules, not styling:
 *
 *  - media whose `origin` is `external` or `ipfs` is NEVER loaded automatically. Loading a
 *    third-party image discloses the viewer IP address, User-Agent and the page they are on to
 *    whoever the seller chose. It takes a deliberate click, and the host is shown first.
 *  - seller text is rendered as text. It is never injected as HTML, never used as a URL the app
 *    navigates to on its own, and never treated as an instruction. [MASTER_PLAN 0.24.P]
 *  - when a seller supplied no media at all, a deterministic local mark is generated from the
 *    id, so the layout never collapses and no placeholder is fetched from anywhere.
 */

import { useMemo, useState } from "react";
import { coverSvg, logoSvg, toDataUri } from "../lib/mediaEngine";

export interface MediaRef {
  kind: "image" | "video";
  uri: string;
  alt: string;
  origin: "same_origin" | "external" | "ipfs";
}

export interface SellerProfile {
  present: boolean;
  name: string;
  tagline: string;
  description: string;
  highlights: string[];
  tags: string[];
  category: string;
  logo: MediaRef | null;
  cover: MediaRef | null;
  media: MediaRef[];
  uri: string;
  rejectedFields: string[];
  note: string;
  mediaNote: string;
}

/* ------------------------------------------------------------- generated */

/**
 * Generated artwork, from the SAME engine that writes the files in `public/media`.
 *
 * Sharing the engine is what makes the fallback invisible: a listing rendered from a generated
 * file and the same listing rendered client-side produce identical pixels, so nothing changes
 * appearance the moment the offline generator happens to run. Seeded by the on-chain id, never by
 * a seller-supplied name — a name can be copied, an id cannot, so two stores calling themselves
 * the same thing still look completely different.
 */
export function GeneratedMark({ seed, size = 40, label }: { seed: string; size?: number; label?: string }) {
  const src = useMemo(() => toDataUri(logoSvg(seed, "")), [seed]);
  return (
    <img
      className="mark"
      src={src}
      width={size}
      height={size}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      decoding="async"
    />
  );
}

/** Deterministic fallback cover, drawn locally. Never a network request. */
export function GeneratedPattern({ seed }: { seed: string }) {
  const src = useMemo(() => toDataUri(coverSvg(seed, "")), [seed]);
  return <img className="media-el" src={src} alt="" aria-hidden="true" decoding="async" />;
}

/* ----------------------------------------------------------------- logo */

export function Logo({
  media,
  seed,
  size = 40,
  label,
}: {
  media: MediaRef | null | undefined;
  seed: string;
  size?: number;
  label?: string;
}) {
  // A logo is small and ever-present, so a third-party one would be a beacon on every row.
  // Only same-origin logos load without a click; anything else falls back to the generated mark.
  if (media && media.origin === "same_origin") {
    return (
      <img
        className="logo-img"
        src={media.uri}
        alt={media.alt || label || ""}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
      />
    );
  }
  return <GeneratedMark seed={seed} size={size} label={label} />;
}

/* ---------------------------------------------------------------- cover */

function hostOf(uri: string): string {
  try {
    if (uri.startsWith("ipfs://")) return "an IPFS gateway";
    return new URL(uri).host;
  } catch {
    return "an external host";
  }
}

/**
 * One media frame. External media shows a consent panel naming the host until the viewer opts in.
 * The opt-in is per-item and per-mount: it is never persisted, so it cannot become a standing
 * grant a seller can rely on.
 */
export function MediaFrame({
  media,
  seed,
  ratio = "16 / 7",
  rounded = true,
}: {
  media: MediaRef | null | undefined;
  seed: string;
  ratio?: string;
  rounded?: boolean;
}) {
  const [allowed, setAllowed] = useState(false);
  const [failed, setFailed] = useState(false);

  const className = `media-frame${rounded ? "" : " square"}`;

  if (!media || failed) {
    return (
      <div className={className} style={{ aspectRatio: ratio }}>
        <GeneratedPattern seed={seed} />
      </div>
    );
  }

  if (media.origin !== "same_origin" && !allowed) {
    return (
      <div className={className} style={{ aspectRatio: ratio }}>
        <GeneratedPattern seed={seed} />
        <div className="media-consent">
          <div className="tiny">
            This seller media is hosted by <strong>{hostOf(media.uri)}</strong>. Loading it tells that
            host your IP address.
          </div>
          <button type="button" className="btn small" onClick={() => setAllowed(true)}>
            Load seller media
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={className} style={{ aspectRatio: ratio }}>
      {media.kind === "video" ? (
        // No autoplay: motion the viewer did not ask for, on untrusted content, on every card.
        <video
          className="media-el"
          src={media.uri}
          controls
          preload="none"
          playsInline
          aria-label={media.alt || "Seller video"}
          onError={() => setFailed(true)}
        />
      ) : (
        <img
          className="media-el"
          src={media.uri}
          alt={media.alt || ""}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      {media.origin !== "same_origin" ? <span className="media-flag">external</span> : null}
    </div>
  );
}

/* --------------------------------------------------------------- gallery */

export function MediaGallery({ media, seed }: { media: MediaRef[]; seed: string }) {
  if (!media || media.length === 0) return null;
  return (
    <div className="gallery">
      {media.map((m, i) => (
        <MediaFrame key={`${m.uri}-${i}`} media={m} seed={`${seed}:${i}`} ratio="4 / 3" />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- description */

/**
 * Seller prose, rendered as plain text in a labelled container.
 *
 * The label is not decoration. An Agent reading the API gets `note` on every seller field; a
 * human reading the UI needs the same boundary drawn, or a convincing paragraph becomes
 * indistinguishable from something the protocol is asserting.
 */
export function SellerProse({
  profile,
  fallback,
}: {
  profile: SellerProfile | null | undefined;
  fallback?: string;
}) {
  const description = profile?.description?.trim();
  if (!description) {
    return fallback ? <p className="seller-prose muted">{fallback}</p> : null;
  }
  return (
    <div className="seller-prose">
      <p>{description}</p>
      {profile?.highlights?.length ? (
        <ul className="highlights">
          {profile.highlights.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      ) : null}
      <div className="tiny dim">
        Written by the seller. The protocol does not verify, endorse or act on any of it.
      </div>
    </div>
  );
}

export function TagRow({ tags }: { tags: string[] | undefined }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className="tag-row">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
        </span>
      ))}
    </div>
  );
}

/** Shown when the indexer dropped part of a seller profile, so a reader is never misled. */
export function RejectedFields({ fields }: { fields: string[] | undefined }) {
  if (!fields || fields.length === 0) return null;
  return (
    <div className="tiny dim">
      Dropped by content sanitization: {fields.join(", ")}. Rejected fields are never repaired or
      guessed at.
    </div>
  );
}

/** The display name a seller published, falling back to a truncated id rather than inventing one. */
export function displayName(profile: SellerProfile | null | undefined, fallbackName: string, id: string): string {
  const name = profile?.name?.trim() || fallbackName?.trim();
  if (name) return name;
  return `${id.slice(0, 10)}…`;
}
