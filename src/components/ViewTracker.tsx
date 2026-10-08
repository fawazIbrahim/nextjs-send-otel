"use client";

import { useEffect } from "react";
import { recordCounter } from "@/otel/metrics";

// Records a custom counter metric from the browser when a page is viewed.
// Its own Client Component so the pages that use it can stay Server Components.
export function ViewTracker({ metricName }: { metricName: string }) {
  useEffect(() => {
    recordCounter(metricName);
    // Intentionally runs once per mount, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
