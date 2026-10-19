import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "./api.js";

export function ErrorLine({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorMessage(error)}</p> : null;
}

export function useAction<T, V = void>(action: (value: V) => Promise<T>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: action,
    // No mutation is retried: a missing reply can mean the server already acted.
    retry: false,
    onSuccess: () => { void client.invalidateQueries(); },
  });
}

function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}
export function usePollInterval(): number | false {
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== "hidden");
  return visible ? 5000 : false;
}

export function Elapsed({ since, prefix = "" }: { since: string; prefix?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const time = Date.parse(since);
  if (!Number.isFinite(time)) return <span>Time unavailable</span>;
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  const duration = seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`;
  return <span>{prefix}{duration} ago</span>;
}

export const stateLabel = (value: string) => value.replaceAll("_", " ");
export function Status({ value }: { value: string }) {
  return <span className={`badge status-${value}`}>{stateLabel(value)}</span>;
}
export function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid date" : date.toLocaleString();
}
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
