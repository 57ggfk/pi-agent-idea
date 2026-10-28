package dev.pi.agent.rpc

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets

/**
 * Reads UTF-8 lines split strictly on LF (0x0A), stripping one optional preceding CR.
 *
 * Deliberately not a [java.io.BufferedReader]: BufferedReader also splits on Unicode
 * line/paragraph separators (U+2028/U+2029) which are valid inside JSON strings and
 * would corrupt pi RPC records (see pi docs/rpc.md "Framing").
 */
class LfLineReader(private val input: InputStream) : Closeable {

    private val buffer = ByteArray(BUFFER_SIZE)
    private var bufferPos = 0
    private var bufferLen = 0
    private val pending = ByteArrayOutputStream()

    /**
     * Returns the next line without its terminator, or `null` at EOF.
     * A final unterminated line is still returned.
     */
    fun readLine(): String? {
        while (true) {
            if (bufferPos >= bufferLen) {
                bufferLen = input.read(buffer)
                bufferPos = 0
                if (bufferLen < 0) {
                    return if (pending.size() > 0) finish() else null
                }
            }
            var i = bufferPos
            while (i < bufferLen && buffer[i] != LF) i++
            pending.write(buffer, bufferPos, i - bufferPos)
            if (i < bufferLen) {
                bufferPos = i + 1
                return finish()
            }
            bufferPos = i
        }
    }

    private fun finish(): String {
        var bytes = pending.toByteArray()
        if (bytes.isNotEmpty() && bytes[bytes.size - 1] == CR) {
            bytes = bytes.copyOf(bytes.size - 1)
        }
        pending.reset()
        return String(bytes, StandardCharsets.UTF_8)
    }

    @Throws(IOException::class)
    override fun close() {
        input.close()
    }

    companion object {
        private const val LF: Byte = 0x0A
        private const val CR: Byte = 0x0D
        private const val BUFFER_SIZE = 64 * 1024
    }
}
