/**
 * How the status bar shows the pi version (issue #6).
 *
 * Two facts, both true: the version of the pi process the plugin is running,
 * and the version installed on the machine. They are equal until the user
 * upgrades pi outside the IDE — then the disk moves and the running process
 * does not, and the status bar has to say so instead of showing a number that
 * is no longer true.
 *
 * The decision is a pure function so it can be tested without rendering the
 * component (the web tests drive logic, not the DOM).
 */

/** What the status bar shows about the pi version. */
export type PiVersionDisplay = {
  /** The version of the running pi process ("" when unknown). */
  running: string;
  /** The version installed on disk ("" when unknown). */
  disk: string;
  /**
   * True when the disk holds a different version than the running process —
   * the user upgraded pi outside the IDE and the process still runs the old
   * code until it restarts.
   */
  differs: boolean;
};

/**
 * The version facts as the status bar renders them.
 *
 * An unknown disk version is not a difference: it means the plugin does not
 * know yet, not that the two disagree. Treating "unknown" as "different"
 * would show a restart warning on every machine where the probe failed.
 */
export function piVersionDisplay(running: string, disk: string): PiVersionDisplay {
  const r = running ?? "";
  const d = disk ?? "";
  return {
    running: r,
    disk: d,
    differs: Boolean(r && d && r !== d),
  };
}
