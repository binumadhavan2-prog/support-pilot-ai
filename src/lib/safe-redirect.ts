/**
 * Returns `target` only if it is a same-origin relative path; otherwise `fallback`.
 * Prevents open redirects through a `?next=` parameter (e.g. `//evil.example`, `/\evil.example`).
 */
export function safeRedirectPath(target: unknown, fallback = "/inbox"): string {
  if (typeof target !== "string" || target.length === 0 || target.length > 512) return fallback;
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) {
    return fallback;
  }
  // Reject control characters, which some browsers strip before resolving the URL.
  if (/[\u0000-\u001f\u007f]/.test(target)) return fallback;
  try {
    const resolved = new URL(target, "http://same-origin.invalid");
    if (resolved.origin !== "http://same-origin.invalid") return fallback;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return fallback;
  }
}
