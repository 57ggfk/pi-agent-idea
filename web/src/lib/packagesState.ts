import type { PackagesListResult } from "../manage";

/**
 * Which empty-state slot the packages list area must render (037 US2/US3).
 * Before 037 a not-yet-loaded `result` (null) fell into the same branch as a
 * genuinely empty list, so entering the panel flashed "No packages installed."
 * while the first `manage.packagesList` was still in flight.
 */
export type PackagesListState =
  | "loading" // result not returned yet (first load / explicit refresh)
  | "error" // a result came back carrying an error
  | "empty" // a real result with no installed packages
  | "list"; // a real result with rows to render

export function packagesListState(result: PackagesListResult | null): PackagesListState {
  if (result === null) return "loading";
  if (result.error) return "error";
  if (!result.entries || result.entries.length === 0) return "empty";
  return "list";
}
