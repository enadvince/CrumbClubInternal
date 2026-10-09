/** Light / dark / follow the system, remembered per device (localStorage). */
export const THEME_KEY = "crumbclub-theme";
export type ThemeChoice = "light" | "dark" | "system";

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): "light" | "dark" {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

export function applyTheme(choice: ThemeChoice) {
  try { localStorage.setItem(THEME_KEY, choice); } catch { /* private mode: applies to this page only */ }
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  document.documentElement.dataset.theme = resolveTheme(choice, systemDark);
}

/** Runs in <head> before first paint so there's no flash of the wrong theme. */
export const themeScript = `(function(){try{var c=localStorage.getItem(${JSON.stringify(THEME_KEY)})||"system";var d=c==="dark"||(c==="system"&&window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light"}catch(e){document.documentElement.dataset.theme="light"}})();`;
