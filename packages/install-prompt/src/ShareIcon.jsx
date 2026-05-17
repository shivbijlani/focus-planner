/**
 * iOS Share glyph (the square with an up-arrow). Matches what users see at
 * the bottom (portrait) or top (landscape/iPad) of Safari.
 */
export function ShareIcon({ size = 18, color = 'currentColor' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: 'middle' }}
    >
      <path d="M12 3v12" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  )
}
