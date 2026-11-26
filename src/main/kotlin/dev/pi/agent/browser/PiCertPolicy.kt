package dev.pi.agent.browser

/**
 * Certificate-error policy hook (spec 060 T006). The default is strict: CEF
 * renders its "Privacy error" interstitial, which is a readable error page —
 * never a white screen (probe P-3 on the real machine, all three certificate
 * classes).
 *
 * Spec [043](../../../../specs/043-browser-protocol-cert/spec.md) owns the
 * configurable policy (allow-insecure toggle / trusted certificate files /
 * host whitelist). It implements this interface and the kernel wires it in —
 * the kernel itself never grows policy logic.
 *
 * Probe P-3 also fixed the proceed mechanics for whoever implements
 * relaxation: the ONLY path is `org.cef.callback.CefCallback.Continue()`
 * (capital C, JCEF 122) from `CefRequestHandler.onCertificateError`; the CDP
 * `Security.handleCertificateError` "proceed" action is rejected by CEF.
 */
interface PiCertPolicy {
    /**
     * @return true to proceed despite the error (`callback.Continue()` MUST
     * have been called), false to keep the interstitial.
     */
    fun onError(errorCode: String, requestUrl: String, sslInfoStatus: Int): Boolean
}

object StrictCertPolicy : PiCertPolicy {
    override fun onError(errorCode: String, requestUrl: String, sslInfoStatus: Int): Boolean = false
}
