import { describe, expect, it } from "vitest";
import { piVersionDisplay } from "./piVersion";

/**
 * The status bar shows two version facts (issue #6): the pi process the
 * plugin is running, and the pi installed on the machine. They differ when
 * the user upgraded pi outside the IDE.
 */
describe("piVersionDisplay", () => {
  it("shows a single version when both agree", () => {
    const v = piVersionDisplay("1.6.1", "1.6.1");
    expect(v.differs).toBe(false);
    expect(v.running).toBe("1.6.1");
    expect(v.disk).toBe("1.6.1");
  });

  it("marks the difference when the disk moved ahead of the process", () => {
    const v = piVersionDisplay("1.6.0", "1.6.1");
    expect(v.differs).toBe(true);
    expect(v.running).toBe("1.6.0");
    expect(v.disk).toBe("1.6.1");
  });

  it("an unknown disk version is not a difference", () => {
    expect(piVersionDisplay("1.6.1", "").differs).toBe(false);
    expect(piVersionDisplay("", "1.6.1").differs).toBe(false);
    expect(piVersionDisplay("", "").differs).toBe(false);
  });

  it("an unknown running version is not a difference either", () => {
    // pi is not running yet: there is nothing to compare against, and a
    // restart warning would be noise.
    const v = piVersionDisplay("", "1.6.1");
    expect(v.differs).toBe(false);
    expect(v.disk).toBe("1.6.1");
  });

  it("a downgraded disk version still counts as a difference", () => {
    // The user rolled pi back. The running process is not what is on disk,
    // and the status bar should say so just the same.
    expect(piVersionDisplay("1.6.1", "1.6.0").differs).toBe(true);
  });
});
