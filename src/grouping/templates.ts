/**
 * Build a RegExp from a template string by:
 * 1. Escaping all regex special characters.
 * 2. Replacing {slot_name} placeholders with (.+) capture groups.
 */
export function templateToRegex(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Restore our slot placeholders (which were escaped as \{slot\})
  const pattern = escaped.replace(/\\\{[^}]+\\\}/g, "(.+)");
  return new RegExp(`^${pattern}$`, "i");
}

/**
 * Returns true if the given message matches the template.
 */
export function matchesTemplate(template: string, message: string): boolean {
  try {
    return templateToRegex(template).test(message);
  } catch {
    return false;
  }
}
