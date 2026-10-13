import { Spinner } from "@/components/ui";

/** Shown inside the owner layout the moment a link is tapped, while the next page loads. */
export default function AdminLoading() {
  return (
    <div className="flex min-h-[50dvh] items-center justify-center">
      <Spinner />
    </div>
  );
}
