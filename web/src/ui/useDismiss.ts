import { type RefObject, useEffect, useRef } from "react";

/** While `open`: a press outside `ref`, or Escape, calls `onClose` (popovers and menus). */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open]);
}
