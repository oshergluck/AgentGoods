/**
 * The AgentGoods.AI mark.
 *
 * An isometric cube — goods — with a single unit lifting clear of the top face: an agent moving
 * something, which is the entire product in one shape.
 *
 * Built from flat polygons and one gradient rather than strokes or filters, for one practical
 * reason: it has to stay legible at 16px in a browser tab. Thin strokes disappear at that size and
 * blur filters turn to mud, so the three faces are separated by opacity alone and the floating unit
 * is sized to survive the downscale as a visible dash.
 *
 * `background` draws the dark rounded tile behind it — wanted for a favicon, where the tab colour
 * is out of our control, and not wanted in the header, where it sits on our own surface.
 */
export function Logo({
  size = 26,
  background = false,
  title,
}: {
  size?: number;
  background?: boolean;
  title?: string;
}) {
  // One gradient id per instance, so two logos on a page cannot collide in the SVG id namespace.
  const id = `ag-mark-${size}-${background ? "bg" : "flat"}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#38e1d2" />
          <stop offset="100%" stopColor="#8b7cf6" />
        </linearGradient>
      </defs>

      {background && <rect width="32" height="32" rx="7.5" fill="#05070d" />}

      {/* The unit in transit, clear of the cube. */}
      <polygon points="16,2.2 21.2,5 16,7.8 10.8,5" fill={`url(#${id})`} />

      {/* Top face: full strength, so the eye reads the solid before the sides. */}
      <polygon points="16,9.8 23.97,14.4 16,19 8.03,14.4" fill={`url(#${id})`} />
      {/* Right and left faces. Separated by opacity rather than by outline, but kept high enough
          that they stay brand-coloured instead of going grey against the near-black tile. */}
      <polygon points="23.97,14.4 23.97,23.6 16,28.2 16,19" fill={`url(#${id})`} opacity="0.78" />
      <polygon points="8.03,14.4 16,19 16,28.2 8.03,23.6" fill={`url(#${id})`} opacity="0.52" />
    </svg>
  );
}
