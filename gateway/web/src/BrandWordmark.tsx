interface BrandWordmarkProps { size?: number | undefined; className?: string | undefined }

/**
 * The service mark: the icon (rendered by scripts/render-branding.sh, served from /gw/assets/) and the name as live text.
 * @param props.size - icon height in px, and the text follows it (default 24).
 * @param props.className - extra class for layout placement.
 */
export function BrandWordmark({ size = 24, className }: BrandWordmarkProps) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size / 3), lineHeight: 1 }}>
      <img src="/gw/assets/brand-icon.png" width={size} height={size} alt="" style={{ borderRadius: Math.round(size / 5) }} />
      <span style={{ fontWeight: 600, fontSize: Math.round(size * 0.8), letterSpacing: '-0.01em' }}>dsh-cloud</span>
    </span>
  );
}
