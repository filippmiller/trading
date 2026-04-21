"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * Lightweight toast primitive — no dependency on `sonner` or any external
 * library. Three reasons we hand-roll here:
 *   1. The paper page only ever shows API rejection reasons — no actions,
 *      no promise states, no rich children. The whole surface fits in 80
 *      lines of JSX.
 *   2. Keeps the bundle small — `sonner` pulls ~10kb gzipped for a single
 *      use case.
 *   3. Matches the rest of the app's hand-rolled aesthetic (Tailwind +
 *      lucide-react, no floating-ui / radix / headlessui dependency).
 *
 * W5 requirement: surface the full rejection reason code
 * (ORDER_NOT_PENDING_FILLED, INSUFFICIENT_CASH, DUPLICATE_SHORT_POSITION etc)
 * so the user sees exactly what the engine said. Toasts:
 *   - Bottom-right stack.
 *   - Auto-dismiss after 6 seconds.
 *   - Tap to dismiss.
 *   - Stack vertically when multiple fire in quick succession.
 */

export type ToastVariant = "error" | "success" | "info";

export type Toast = {
  id: string;
  variant: ToastVariant;
  title?: string;
  message: string;
  /** If set, dismiss after this many ms. Defaults to 6000. */
  durationMs?: number;
};

type ToastContextValue = {
  toast: (t: Omit<Toast, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/** Generate a toast id. Non-cryptographic — just enough entropy for React keys. */
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback((t: Omit<Toast, "id"> & { id?: string }): string => {
    const id = t.id ?? genId();
    const duration = t.durationMs ?? 6000;
    setToasts((prev) => [...prev, { ...t, id }]);
    if (duration > 0) {
      const timer = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, timer);
    }
    return id;
  }, [dismiss]);

  useEffect(() => {
    // Cleanup on unmount — clear all pending timers to avoid "setState after
    // unmount" warnings during hot reload.
    const currentTimers = timers.current;
    return () => {
      for (const timer of currentTimers.values()) clearTimeout(timer);
      currentTimers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-full max-w-sm"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const styles = variantStyles(toast.variant);
  return (
    <button
      type="button"
      onClick={onDismiss}
      className={`pointer-events-auto text-left w-full rounded-xl border shadow-lg p-3 pr-4 transition animate-[fadeInUp_180ms_ease-out] ${styles.bg} ${styles.border} ${styles.text}`}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 h-2 w-2 rounded-full flex-shrink-0 ${styles.dot}`} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          {toast.title && <p className="text-sm font-bold leading-tight">{toast.title}</p>}
          <p className={`text-xs leading-snug font-mono break-words ${toast.title ? "mt-0.5 opacity-80" : ""}`}>
            {toast.message}
          </p>
        </div>
        <span className={`text-xs opacity-60 flex-shrink-0 ${styles.text}`}>×</span>
      </div>
    </button>
  );
}

function variantStyles(v: ToastVariant) {
  switch (v) {
    case "error":
      return { bg: "bg-rose-50", border: "border-rose-200", text: "text-rose-900", dot: "bg-rose-500" };
    case "success":
      return { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-900", dot: "bg-emerald-500" };
    case "info":
    default:
      return { bg: "bg-zinc-50", border: "border-zinc-200", text: "text-zinc-900", dot: "bg-zinc-500" };
  }
}
