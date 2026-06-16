export interface LogEntry {
  timestamp: string;
  category: string;
  message: string;
  raw: string;
}

/**
 * Parse a complete log entry (may span multiple lines) into structured fields.
 * Expected formats:
 *   `[timestamp] [category] message`  — standard entries
 *   `[timestamp] message`             — entries without a category bracket (e.g. banner)
 */
function parseEntry(raw: string): LogEntry | null {
  // Standard: [ts] [category] message
  let m = raw.match(/^\[([^\]]+)\] \[([\w-]+)\]\s?([\s\S]*)$/);
  if (m) {
    return { timestamp: m[1], category: m[2], message: m[3], raw };
  }
  // Fallback: [ts] message (no category bracket)
  m = raw.match(/^\[([^\]]+)\]\s?([\s\S]*)$/);
  if (m) {
    return { timestamp: m[1], category: "system", message: m[2], raw };
  }
  return null;
}

/**
 * Parse log content into structured entries.
 * Entries are grouped by lines starting with an ISO timestamp — continuation
 * lines (e.g. indented JSON from JSON.stringify) are attached to the preceding
 * entry.
 */
export function parseLog(content: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const raw = current.join("\n");
    const entry = parseEntry(raw);
    if (entry) entries.push(entry);
    current = [];
  };

  for (const line of content.split("\n")) {
    if (/^\[\d{4}-\d{2}-\d{2}T/.test(line)) {
      flush();
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  flush();

  return entries;
}
