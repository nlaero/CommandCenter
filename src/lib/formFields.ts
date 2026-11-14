import type { AdapterField } from "../types";

/**
 * Checkbox state for a source setting.
 * An explicit false stays off. A missing value uses `defaultChecked`, which is
 * how radar, archives, captions, and map follow already behave at runtime.
 */
export function booleanFieldChecked(
  field: Pick<AdapterField, "defaultChecked">,
  value: unknown,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "1" || text === "true" || text === "yes" || text === "on") return true;
    if (text === "0" || text === "false" || text === "no" || text === "off") return false;
    if (text === "") return Boolean(field.defaultChecked);
  }
  if (value === undefined || value === null) return Boolean(field.defaultChecked);
  return Boolean(value);
}
