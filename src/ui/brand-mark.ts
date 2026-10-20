/**
 * The canonical PLUTON brand mark.
 *
 * ONE mark, two renderings:
 *
 *  - the web SPA draws it as SVG (`PLUTON_MARK_BODY`);
 *  - the terminal draws the same silhouette as text art (`src/ui/brand.ts`).
 *
 * The silhouette is layered, bottom to top, and both renderings must show the
 * same layers in the same order — that is what makes them one mark rather
 * than two logos:
 *
 *   1. `hull`  — a deep, rounded galley hull (the terminal's `\____/` row);
 *   2. `sail`  — the large lateen sail carried by the main mast;
 *   3. `jib`   — the smaller fore-sail forward of the mast;
 *   4. `yard`  — the horizontal spar across the masthead;
 *   5. `mast`  — the vertical spar running from the hull to the yard;
 *   6. `skull` — the mark at the masthead, the product's signature.
 *
 * The SVG is authored on a 24x24 grid and scaled by the caller. It is drawn
 * with strokes (like every other icon in the SPA) plus two filled areas (the
 * sails and the skull) so the shape still reads at 16 CSS pixels.
 *
 * This module is deliberately dependency-free: it is imported by the server's
 * embedded-asset module, which must not pull the terminal theme in with it.
 */

/** The layers of the canonical mark, in drawing order (bottom to top). */
export const PLUTON_MARK_LAYERS = ['hull', 'sail', 'jib', 'yard', 'mast', 'skull'] as const

export type PlutonMarkLayer = (typeof PLUTON_MARK_LAYERS)[number]

/** The SVG viewBox the mark is authored on. */
export const PLUTON_MARK_VIEWBOX = '0 0 24 24'

/**
 * The mark's SVG body (the children of the `<svg>` element).
 *
 * Kept as a single string so the embedded-asset module can interpolate it
 * into both the favicon data URI and the page markup without duplicating the
 * geometry.
 */
export const PLUTON_MARK_BODY =
  '<path d="M3 13.4h18c0 3.2-4 5.4-9 5.4s-9-2.2-9-5.4z"/>' +
  '<path d="M11.1 13.2V6.6L6 13.2z" fill="currentColor" stroke="none" opacity="0.85"/>' +
  '<path d="M12.9 13.2V8.4L17 13.2z" fill="currentColor" stroke="none" opacity="0.7"/>' +
  '<path d="M7.4 9.2h9.2"/>' +
  '<path d="M12 13.4V7.2"/>' +
  '<path fill-rule="evenodd" d="M12 1.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z' +
  'M11.1 3.2a0.5 0.5 0 1 0 0 1 0.5 0.5 0 0 0 0-1Z' +
  'M12.9 3.2a0.5 0.5 0 1 0 0 1 0.5 0.5 0 0 0 0-1Z" fill="currentColor" stroke="none"/>'

/**
 * Build the mark as a standalone `<svg>` element.
 *
 * @param size  CSS pixel size for the square icon (default 16).
 * @param extra extra attributes (class, title, …) placed on the `<svg>`.
 */
export function plutonMarkSvg(size = 16, extra = ''): string {
  return (
    `<svg viewBox="${PLUTON_MARK_VIEWBOX}" width="${size}" height="${size}" ` +
    `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true"${extra ? ' ' + extra : ''}>` +
    PLUTON_MARK_BODY +
    '</svg>'
  )
}

/**
 * The mark as a URL-encoded SVG, for a `<link rel="icon">` data URI.
 *
 * The background is opaque so the mark stays legible on any tab colour.
 */
export function plutonMarkFaviconDataUri(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${PLUTON_MARK_VIEWBOX}" color="#a78bfa">` +
    `<rect width="24" height="24" rx="6" fill="#09080e"/>` +
    `<g fill="none" stroke="#a78bfa" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
    PLUTON_MARK_BODY +
    '</g></svg>'
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}
