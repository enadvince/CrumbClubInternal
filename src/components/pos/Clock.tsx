"use client";
import { useEffect, useState } from "react";

const fmt = new Intl.DateTimeFormat("en-PH", { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** The tablet's own clock, ticking every second. Renders nothing until mounted so server and client markup match. */
export function Clock({ className = "" }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return null;
  return (
    <time dateTime={now.toISOString()} className={`tabular-nums ${className}`}>
      {fmt.format(now)}
    </time>
  );
}
