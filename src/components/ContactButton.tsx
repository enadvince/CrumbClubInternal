import { SUPPORT_URL, withUtm } from "@/lib/links";

/** Floating "Contact support" link. Public pages only; the POS has Help in its menu instead. */
export function ContactButton({ page }: { page: string }) {
  return (
    <a
      href={withUtm(SUPPORT_URL, { medium: "floating-button", content: page })}
      target="_blank"
      rel="noopener"
      className="no-print btn-ube fixed right-4 bottom-4 z-30 min-h-12 rounded-full px-5 shadow-xl"
    >
      <span aria-hidden>💬</span> Contact support
    </a>
  );
}
