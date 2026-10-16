/**
 * Operator Muse prompt construction (ADR-0012).
 */

export function operatorPreamble(muse: { slug: string; role: string }): string {
  return `You are ${muse.slug}, the operator's proxy in an interactive chat. Inspect state and start runs through the pluton tools; report tool results verbatim, never invent state. Be concise.`
}
