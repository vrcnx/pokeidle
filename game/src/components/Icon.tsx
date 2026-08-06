// Flat outline SVG icons (Lucide-style). Stroke-only, currentColor so
// they inherit the parent's text color. Replace emoji throughout the UI
// for a more polished look.

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

const baseProps = (size: number, strokeWidth: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  "aria-hidden": true,
});

export function IconSettings({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconChat({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function IconHeart({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

export function IconCoin({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M14.5 9a3 3 0 0 0-2.5-1c-1.7 0-3 .9-3 2 0 2.5 6 1 6 4 0 1.5-1.3 2-3 2a3 3 0 0 1-2.5-1" />
      <line x1="12" y1="6" x2="12" y2="7.5" />
      <line x1="12" y1="16.5" x2="12" y2="18" />
    </svg>
  );
}

export function IconMedal({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M7.5 2 9 7m6-5-1.5 5" />
      <circle cx="12" cy="14" r="6" />
      <path d="M9.5 14 8 16l1 1.5-1 1.5 1.5-1.5L10 19l1-1.5 1 1.5 1-1.5 1.5 1.5L14 18l1-1.5-1.5-2" />
    </svg>
  );
}

export function IconStar({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

export function IconTicket({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M3 7v4a2 2 0 0 1 0 4v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a2 2 0 0 1 0-4V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" />
      <line x1="13" y1="5" x2="13" y2="7" />
      <line x1="13" y1="11" x2="13" y2="13" />
      <line x1="13" y1="17" x2="13" y2="19" />
    </svg>
  );
}

export function IconCrown({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14" />
    </svg>
  );
}

// Lucide-style info icon: circle with an "i" formed by a dot above and
// a vertical stroke below. Used for the inline tooltip-trigger glyph
// next to section titles.
export function IconInfo({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="12" y1="7.5" x2="12" y2="7.5" />
    </svg>
  );
}

export function IconClose({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

export function IconChevronDown({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconChevronUp({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

export function IconMenu({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function IconChevronLeft({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

export function IconHospital({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <rect x="4" y="6" width="16" height="14" rx="1" />
      <path d="M9 22V12h6v10" />
      <line x1="12" y1="9" x2="12" y2="2" />
      <line x1="9" y1="5" x2="15" y2="5" />
      <line x1="12" y1="14" x2="12" y2="18" />
      <line x1="10" y1="16" x2="14" y2="16" />
    </svg>
  );
}

export function IconBag({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M6 2 3 7v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-3-5z" />
      <line x1="3" y1="7" x2="21" y2="7" />
      <path d="M16 11a4 4 0 0 1-8 0" />
    </svg>
  );
}

export function IconHome({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function IconMountain({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="m3 20 5.5-9 4 6 3-4 5.5 7z" />
    </svg>
  );
}

export function IconLeaf({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.5c1 1.5 1.7 4 1.7 6.5a8 8 0 0 1-7.9 8c-2.4 0-3.7-.5-3.7-.5" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6" />
    </svg>
  );
}

export function IconIsland({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M2 18s1.5-2 4-2 4 2 6 2 4-2 6-2 4 2 4 2" />
      <path d="m12 4-3 6h6z" />
      <line x1="12" y1="10" x2="12" y2="16" />
    </svg>
  );
}

export function IconPin({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export function IconMap({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
      <line x1="8" y1="2" x2="8" y2="18" />
      <line x1="16" y1="6" x2="16" y2="22" />
    </svg>
  );
}

export function IconCart({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

export function IconBackpack({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M8 10V5a4 4 0 1 1 8 0v5" />
      <line x1="8" y1="14" x2="16" y2="14" />
    </svg>
  );
}

export function IconMonitor({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function IconBook({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20" />
    </svg>
  );
}

export function IconPlus({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconEdit({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function IconTarget({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

export function IconSliders({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

// Cell-density pair for the PC box: 2×2 = comfortable, 3×3 = compact. The
// button shows the density it will switch TO, so the two read as one control.
// These exist because the obvious glyphs don't work at toolbar size — U+25AA
// ("▪") measures 5px wide however large you set the font, since it is a
// *small* square by definition rather than a scalable one.
export function IconGridLarge({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1" />
    </svg>
  );
}

export function IconGridSmall({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <rect x="3" y="3" width="4.5" height="4.5" rx="0.8" />
      <rect x="9.75" y="3" width="4.5" height="4.5" rx="0.8" />
      <rect x="16.5" y="3" width="4.5" height="4.5" rx="0.8" />
      <rect x="3" y="9.75" width="4.5" height="4.5" rx="0.8" />
      <rect x="9.75" y="9.75" width="4.5" height="4.5" rx="0.8" />
      <rect x="16.5" y="9.75" width="4.5" height="4.5" rx="0.8" />
      <rect x="3" y="16.5" width="4.5" height="4.5" rx="0.8" />
      <rect x="9.75" y="16.5" width="4.5" height="4.5" rx="0.8" />
      <rect x="16.5" y="16.5" width="4.5" height="4.5" rx="0.8" />
    </svg>
  );
}

// Crossed swords — used for the PvP battle entry point.
export function IconSwords({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <polyline points="14.5,17.5 3,6 3,3 6,3 17.5,14.5" />
      <line x1="13" y1="19" x2="19" y2="13" />
      <line x1="16" y1="16" x2="20" y2="20" />
      <line x1="19" y1="21" x2="21" y2="19" />
      <polyline points="14.5,6.5 18,3 21,3 21,6 17.5,9.5" />
      <line x1="5" y1="14" x2="9" y2="18" />
      <line x1="7" y1="17" x2="4" y2="20" />
      <line x1="3" y1="19" x2="5" y2="21" />
    </svg>
  );
}

// A machine disc — the TM Mart's rail entry. Deliberately not the shopping
// cart the ordinary Mart uses: the two are different shops with different
// rules, and a player scanning the rail should be able to tell at a glance
// which one sells the discs.
export function IconDisc({ size = 16, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...baseProps(size, strokeWidth, className)}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
    </svg>
  );
}
