// Extraction points: what an exit status means.

/** Exit status → short label and colour class. */
export function exfilStatus(status: number): { label: string; tone: "open" | "closed" | "pending" | "neutral" } {
  switch (status) {
    case 1: return { label: "closed", tone: "closed" };
    case 2: return { label: "requirements", tone: "pending" };
    case 3: return { label: "countdown", tone: "neutral" };
    case 4: return { label: "open", tone: "open" };
    case 5: return { label: "pending", tone: "pending" };
    case 6: return { label: "manual", tone: "neutral" };
    default: return { label: "?", tone: "neutral" };
  }
}
