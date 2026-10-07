/** Tiny haptic tick on supporting devices (Android tablets). */
export function tapFeedback() {
  try {
    navigator.vibrate?.(8);
  } catch {
    // ignore
  }
}
