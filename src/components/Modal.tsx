"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Accessible modal built on the native <dialog> element (focus trap + Esc for free). */
export function Modal({
  open, onClose, title, children, wide = false,
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-labelledby="modal-title"
      className={`m-auto max-h-[92dvh] w-[calc(100%-2rem)] ${wide ? "max-w-3xl" : "max-w-lg"} rounded-2xl bg-paper p-0 text-ink shadow-2xl ring-1 ring-ink/10 backdrop:bg-ink/40 backdrop:backdrop-blur-sm`}
    >
      {open && (
        <div className="flex max-h-[92dvh] flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-crust px-5 py-3">
            <h2 id="modal-title" className="text-lg font-bold">{title}</h2>
            <button onClick={onClose} className="btn-ghost min-h-11 px-3" aria-label="Close">✕</button>
          </div>
          <div className="overflow-y-auto p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}
