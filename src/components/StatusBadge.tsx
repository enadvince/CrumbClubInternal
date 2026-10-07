import type { EventStatus } from "@/lib/types";

const styles: Record<EventStatus, string> = {
  draft: "bg-crust text-ink-soft",
  live: "bg-ok-light text-ok",
  closed: "bg-ink text-white",
};
const icons: Record<EventStatus, string> = { draft: "✎", live: "●", closed: "🔒" };

export function EventStatusBadge({ status }: { status: EventStatus }) {
  return (
    <span className={`badge ${styles[status]}`}>
      <span aria-hidden>{icons[status]}</span> {status[0].toUpperCase() + status.slice(1)}
    </span>
  );
}
