import "server-only";

/**
 * Sends the owner-invite email through Resend's HTTP API (no SDK needed).
 * Needs RESEND_API_KEY and INVITE_EMAIL_FROM. Without them nothing is sent and
 * the owner copies the link from the Owners page instead.
 */
export const isInviteEmailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.INVITE_EMAIL_FROM);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function inviteEmailContent(p: { businessName: string; inviterName: string | null; link: string }) {
  const invited = p.inviterName ? `${p.inviterName} has invited you` : "You've been invited";
  const subject = `You're invited to manage ${p.businessName} on Crumb Club`;
  const text = [
    `${invited} to be an owner of ${p.businessName} on Crumb Club POS.`,
    "",
    "Open this link to create your account and get access to the owner pages:",
    p.link,
    "",
    "The link works once and expires in 7 days. If you weren't expecting this, you can ignore this email.",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#2b2118">
<p>${escapeHtml(invited)} to be an owner of <strong>${escapeHtml(p.businessName)}</strong> on Crumb Club POS.</p>
<p><a href="${escapeHtml(p.link)}" style="display:inline-block;background:#b5651d;color:#fff;padding:12px 20px;border-radius:12px;text-decoration:none;font-weight:600">Create your owner account</a></p>
<p style="font-size:14px;color:#6b5a4b">Or paste this link into your browser:<br>${escapeHtml(p.link)}</p>
<p style="font-size:14px;color:#6b5a4b">The link works once and expires in 7 days. If you weren't expecting this, you can ignore this email.</p>
</div>`;
  return { subject, text, html };
}

/** Returns null on success, or an error message. */
export async function sendInviteEmail(to: string, content: { subject: string; text: string; html: string }): Promise<string | null> {
  if (!isInviteEmailConfigured()) return "Email sending isn't set up (RESEND_API_KEY / INVITE_EMAIL_FROM).";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.INVITE_EMAIL_FROM, to: [to], ...content }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return body?.message ?? `Email provider returned ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : "Could not reach the email provider";
  }
}
