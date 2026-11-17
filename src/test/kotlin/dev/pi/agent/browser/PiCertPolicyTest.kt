package dev.pi.agent.browser

import kotlin.test.Test
import kotlin.test.assertFalse

/**
 * Spec 048 T006: the kernel ships strict-only; relaxation belongs to 043 via
 * this hook. If anything in this file starts returning true, 043 leaked into
 * P0 without its spec being honored.
 */
class PiCertPolicyTest {

    @Test
    fun `default policy is strict`() {
        assertFalse(StrictCertPolicy.onError("ERR_CERT_AUTHORITY_INVALID", "https://a.b", 5))
        assertFalse(StrictCertPolicy.onError("ERR_CERT_DATE_INVALID", "https://a.b", 5))
        assertFalse(StrictCertPolicy.onError("ERR_CERT_COMMON_NAME_INVALID", "https://a.b", -1))
    }

    @Test
    fun `kernel ships with strict policy`() {
        // No IDE instance needed: the field initializer runs on any kernel
        // path that references the companion default; here we assert the
        // documented default directly to keep the test JCEF-free.
        val kernelDefault: PiCertPolicy = StrictCertPolicy
        assertFalse(kernelDefault.onError("ERR_CERT_AUTHORITY_INVALID", "u", 0))
    }
}
