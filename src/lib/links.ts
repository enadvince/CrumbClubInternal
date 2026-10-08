/** Every outbound link carries UTM tags so Waddle Labs can see where visits come from. */
export const UTM_SOURCE = "crumb-club-pos";

export function withUtm(url: string, opts: { medium?: string; campaign?: string; content?: string } = {}): string {
  if (!/^https?:\/\//i.test(url)) return url; // mailto:, tel:, relative links are left alone
  const u = new URL(url);
  const set = (k: string, v: string | undefined) => { if (v && !u.searchParams.has(k)) u.searchParams.set(k, v); };
  set("utm_source", UTM_SOURCE);
  set("utm_medium", opts.medium ?? "referral");
  set("utm_campaign", opts.campaign ?? "app");
  set("utm_content", opts.content);
  return u.toString();
}

/** Waddle Labs support. Override with NEXT_PUBLIC_SUPPORT_URL. */
export const SUPPORT_URL = process.env.NEXT_PUBLIC_SUPPORT_URL || "https://waddlelabs.com/contact";
