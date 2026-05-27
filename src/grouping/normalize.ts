/**
 * Normalize an error message by replacing variable runtime data with placeholders.
 * Replacements are applied in order as specified.
 */
export function normalizeMessage(message: string): string {
  let m = message;

  // UUIDs
  m = m.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "{uuid}",
  );

  // Hex strings (0x prefixed or bare 8+ hex chars)
  m = m.replace(/0x[0-9a-f]{8,}/gi, "{hex}");
  m = m.replace(/\b[0-9a-f]{8,}\b/g, "{hex}");

  // Email addresses
  m = m.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "{email}");

  // IP addresses (before numeric replacement)
  m = m.replace(
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    "{ip}",
  );

  // File paths (Unix and Windows)
  m = m.replace(/(?:\/[a-zA-Z0-9._\-]+){2,}/g, "{path}");
  m = m.replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, "{path}");

  // Integers of 4+ digits
  m = m.replace(/\b\d{4,}\b/g, "{id}");

  return m;
}
