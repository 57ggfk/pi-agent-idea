package dev.pi.agent.browser

/**
 * 069 浏览器操作层: pure builders for the synthetic-event scripts the agent
 * tool injects (browser-use style). CLICK replays the full mouse sequence
 * over the element's center (pointerdown/mousedown/mouseup/click, bubbles —
 * closer to a real user than a bare `el.click()`), TYPE writes text the way
 * React needs it (native prototype value setter + bubbling input event; or
 * execCommand for contenteditable), EVALUATE runs the user's JS and ships
 * the completion value back as a JSON string.
 *
 * All three report over the SAME readback JSQuery channel as the snapshot/
 * scroll, tagged `kind:"action"` so [PiBrowserKernel.onReadResult] can route
 * them; [ActionResult.fromJs] parses the wire shape. Every embedded string
 * goes through [PageSnapshotSanitizer.jsString] — quotes, backslashes,
 * newlines, CJK and `</script>`-shaped payloads stay inert string content.
 */
object BrowserActionScripts {

    /** CLICK reports the matched element's first N characters of text. */
    const val MAX_ELEMENT_TEXT_CHARS = 80

    /**
     * Page-side cap for an EVALUATE value before it rides the channel; the
     * IDE re-caps with [PageSnapshotSanitizer.cleanText] (3000) on arrival.
     */
    const val MAX_EVALUATE_VALUE_CHARS = 4000

    /** Shared miss text for click/type — the model reads it verbatim. */
    private const val MISS = "no element matches selector: "

    /**
     * CLICK: querySelector → scrollIntoView(center) → the full mouse event
     * sequence. A miss answers `found:false` (an executed no-op, not a
     * failure); a page-side throw answers `ok:false` + error.
     */
    fun buildClickScript(injectStatement: String, selector: String): String {
        val sel = PageSnapshotSanitizer.jsString(selector.take(PageSnapshotSanitizer.MAX_SELECTOR_CHARS))
        return """
            (function() {
              var result;
              var sel = $sel;
              try {
                var el = document.querySelector(sel);
                if (!el) {
                  result = JSON.stringify({ kind: 'action', action: 'click', found: false, error: '$MISS' + sel });
                } else {
                  el.scrollIntoView({ block: 'center' });
                  var rect = el.getBoundingClientRect();
                  var opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
                  var fire = function(type, Ctor) { el.dispatchEvent(new Ctor(type, opts)); };
                  fire('pointerdown', window.PointerEvent || MouseEvent);
                  fire('mousedown', MouseEvent);
                  fire('mouseup', MouseEvent);
                  fire('click', MouseEvent);
                  result = JSON.stringify({
                    kind: 'action',
                    action: 'click',
                    found: true,
                    tag: String(el.tagName || '').toLowerCase(),
                    text: String((el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim().slice(0, $MAX_ELEMENT_TEXT_CHARS)
                  });
                }
              } catch (e) {
                result = JSON.stringify({ kind: 'action', action: 'click', ok: false, error: String((e && e.message) || e) });
              }
              $injectStatement
            })()
        """.trimIndent()
    }

    /**
     * TYPE: focus → for input/textarea write through the NATIVE prototype
     * value setter then dispatch a bubbling input event (React's tracked
     * value is bypassed by direct assignment; the setter round-trip keeps it
     * honest) → for contenteditable select-all + execCommand('insertText').
     * A miss answers `found:false`; a throw answers `ok:false` + error.
     */
    fun buildTypeScript(injectStatement: String, selector: String, text: String): String {
        val sel = PageSnapshotSanitizer.jsString(selector.take(PageSnapshotSanitizer.MAX_SELECTOR_CHARS))
        val value = PageSnapshotSanitizer.jsString(text)
        return """
            (function() {
              var result;
              var sel = $sel;
              var value = $value;
              try {
                var el = document.querySelector(sel);
                if (!el) {
                  result = JSON.stringify({ kind: 'action', action: 'type', found: false, error: '$MISS' + sel });
                } else {
                  el.focus();
                  if (el.isContentEditable) {
                    document.execCommand('selectAll', false, null);
                    if (!document.execCommand('insertText', false, value)) {
                      el.textContent = value;
                    }
                  } else {
                    var proto = (el instanceof HTMLInputElement) ? HTMLInputElement.prototype : ((el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : null);
                    var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
                    if (desc && desc.set) { desc.set.call(el, value); } else { el.value = value; }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                  result = JSON.stringify({ kind: 'action', action: 'type', found: true, typed: value.length });
                }
              } catch (e) {
                result = JSON.stringify({ kind: 'action', action: 'type', ok: false, error: String((e && e.message) || e) });
              }
              $injectStatement
            })()
        """.trimIndent()
    }

    /**
     * EVALUATE: the user JS rides a STRING literal into `eval()` so its
     * COMPLETION VALUE comes back (statements and trailing expressions both
     * work, browser-use style). The value is JSON.stringify'd once
     * (undefined/unserializable degrade to a string — never a dropped field),
     * capped, and shipped; a throw answers `ok:false` + error.
     */
    fun buildEvaluateScript(injectStatement: String, js: String): String {
        val code = PageSnapshotSanitizer.jsString(js)
        return """
            (function() {
              var result;
              try {
                var ret = (function() { return eval($code); })();
                var out = (function() {
                  try {
                    var s = JSON.stringify(ret);
                    return (s === undefined ? 'undefined' : s);
                  } catch (se) {
                    return 'unserializable: ' + String((se && se.message) || se);
                  }
                })();
                result = JSON.stringify({ kind: 'action', action: 'evaluate', ok: true, value: String(out).slice(0, $MAX_EVALUATE_VALUE_CHARS) });
              } catch (e) {
                result = JSON.stringify({ kind: 'action', action: 'evaluate', ok: false, error: String((e && e.message) || e) });
              }
              $injectStatement
            })()
        """.trimIndent()
    }
}
