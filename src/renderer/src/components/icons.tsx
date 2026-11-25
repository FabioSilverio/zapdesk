import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }
const base = ({ size = 18, ...p }: P) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p
})

export const DownloadIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4v11" />
    <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
    <path d="M5 19h14" />
  </svg>
)
export const Bell = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </svg>
)
export const PlaneIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="m21 4-9.5 9.5" />
    <path d="M21 4 14.5 20l-3-6.5L5 10.5 21 4Z" />
  </svg>
)
export const TextLines = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 7h14" />
    <path d="M5 12h14" />
    <path d="M5 17h9" />
  </svg>
)
export const Search = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
)
export const Plus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
export const Smile = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8" />
    <path d="M9 9.5h.01M15 9.5h.01" strokeWidth={2.6} />
  </svg>
)
export const StickerIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 12.5V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h5.5" />
    <path d="M20 12.5 12.5 20c0-4.1 3.4-7.5 7.5-7.5Z" />
  </svg>
)
export const Send = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 19V5M6 11l6-6 6 6" strokeWidth={2.2} />
  </svg>
)
export const Reply = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 6 6v4" />
  </svg>
)
export const PinIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 4.5 19.5 9l-3 1.5-3.5 3.5.5 4-1.5 1.5L4.5 12 6 10.5l4 .5 3.5-3.5Z" />
    <path d="m8 16-4 4" />
  </svg>
)
export const More = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={3} />
  </svg>
)
export const LockIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </svg>
)
export const Gear = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </svg>
)
export const Check = (p: P) => (
  <svg {...base({ ...p, viewBox: '0 0 16 12' })}>
    <path d="m2 6.5 3 3L11.5 3" />
  </svg>
)
export const Checks = (p: P) => (
  <svg {...base({ ...p, viewBox: '0 0 20 12' })}>
    <path d="m1.5 6.5 3 3L11 3" />
    <path d="m8.5 9.5 1 0L16 3" />
  </svg>
)
export const Clock = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l2.5 2" />
  </svg>
)
export const X = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)
export const Paperclip = (p: P) => (
  <svg {...base(p)}>
    <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7-7L13 4.5a3.4 3.4 0 0 1 4.8 4.8l-7.7 7.7a1.7 1.7 0 0 1-2.4-2.4l7-7" />
  </svg>
)
export const BellOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M9.5 19a2.5 2.5 0 0 0 5 0M18 13.5V11a6 6 0 0 0-9.3-5M6.3 8.3A6 6 0 0 0 6 11v2.5L4.5 16h11.8M3 3l18 18" />
  </svg>
)
export const Archive = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4" width="17" height="4.5" rx="1.2" />
    <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12.5h4" />
  </svg>
)
export const Chevron = (p: P) => (
  <svg {...base(p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
)
export const Doc = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3.5V8h4.5" />
  </svg>
)
export const Play = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5Z" />
  </svg>
)
export const Pause = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="6.5" y="5" width="4" height="14" rx="1.2" />
    <rect x="13.5" y="5" width="4" height="14" rx="1.2" />
  </svg>
)
export const Star = (p: P) => (
  <svg {...base(p)}>
    <path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6Z" />
  </svg>
)
export const Down = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
)
export const Refresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />
  </svg>
)
export const Grid = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
  </svg>
)
export const Back = (p: P) => (
  <svg {...base(p)}>
    <path d="m15 6-6 6 6 6" />
  </svg>
)
export const Copy = (p: P) => (
  <svg {...base(p)}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </svg>
)
export const Pencil = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </svg>
)
export const Eye = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
)
export const Ghost = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 20V11a7 7 0 0 1 14 0v9l-2.3-1.6L14.3 20 12 18.4 9.7 20l-2.4-1.6Z" />
    <path d="M9.5 11h.01M14.5 11h.01" strokeWidth={2.6} />
  </svg>
)
export const ExportIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  </svg>
)
export const Trash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5M14 11v5" />
  </svg>
)
export const BlockIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8" />
    <path d="m6.4 6.4 11.2 11.2" />
  </svg>
)
export const PhotoIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="9.5" r="1.4" />
    <path d="m20.5 15.5-4.8-4.8a1.2 1.2 0 0 0-1.7 0L6.5 18.2" />
  </svg>
)
export const LinkIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 13a4.5 4.5 0 0 0 6.4.4l2.2-2.2a4.5 4.5 0 0 0-6.4-6.4l-1.3 1.3" />
    <path d="M14 11a4.5 4.5 0 0 0-6.4-.4L5.4 12.8a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3" />
  </svg>
)
export const PollIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 20V10M12 20V4M19 20v-7" />
  </svg>
)
