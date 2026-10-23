// Shared top-band wash (look-sync CONTRACT "Shared top-band darkening (desktop.guard)" and "Light look"): which wash
// alpha (--bg-dim) Helm paints. Following the desktop, it is Mantle's shared alpha for the theme showing (dark:
// desktop.guard.dark, light: desktop.guard.light, the white that keeps ink-2 at 4.7:1), so Mantle's top bar, Quartz's
// strip and Helm match on every photo. The host validates both (main/look.js checkGuard / checkGuardLight); here the
// one for this theme is re-checked against the glass being PAINTED, so dragging the dim or blur slider shows the
// slider's value until Mantle republishes. Own picture: the dim as set. Never silent: a fallback carries its reason.
// ESM with no imports, so test/host/look.test.js loads it with require(esm). Owner: lane guard-helm / wk-light.

const near = (a, b) => Math.abs(+a - +b) < 0.005;

// what the reason says when the host is older than the light guard (no guardLight fields at all)
export const NO_LIGHT_GUARD = 'light top band not published by Mantle yet';

/**
 * washFor(g, mode, desktop)
 *   g: { theme: 'dark'|'light', dim, blurPx } (the glass painted now, previews included)
 *   mode: background.mode ('desktop' | 'own'); desktop: LookState.desktop (guard / guardReason, guardLight / guardLightReason)
 * -> { dim, used, reason }   reason: why the shared value is not used (null when used or when it does not apply)
 */
export function washFor(g, mode, desktop) {
  if (mode !== 'desktop') return { dim: g.dim, used: false, reason: null };
  const light = g.theme === 'light';
  const gd = (desktop && (light ? desktop.guardLight : desktop.guard)) || null;
  if (!gd) {
    const why = desktop && (light ? desktop.guardLightReason : desktop.guardReason);
    return { dim: g.dim, used: false, reason: why || (light ? NO_LIGHT_GUARD : "Mantle hasn't shared a darkening for this wallpaper") };
  }
  if (!near(gd.dim, g.dim) || !near(gd.blurPx, g.blurPx)) {
    const what = light ? "Mantle's light top band is stale: it" : "Mantle's shared darkening";
    return { dim: g.dim, used: false,
      reason: `${what} was worked out for dim ${(+gd.dim).toFixed(2)} / blur ${gd.blurPx}px; waiting for it to catch up with dim ${(+g.dim).toFixed(2)} / blur ${g.blurPx}px` };
  }
  return { dim: gd.alpha, used: true, reason: null };
}
