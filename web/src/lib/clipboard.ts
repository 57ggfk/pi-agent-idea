/**
 * Clipboard access shared by the code-block Copy button and the message action
 * bar.
 *
 * JCEF builds ship without the async clipboard API, so `navigator.clipboard`
 * rejects there and the `execCommand("copy")` fallback is the real path, not a
 * legacy nicety. Callers get a boolean so a failure can be shown as a failure
 * instead of a fake success tick (spec FR-004).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyTextFallback(text);
  }
}

function copyTextFallback(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
