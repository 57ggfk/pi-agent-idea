package dev.pi.agent.browser

import java.io.File
import java.io.RandomAccessFile

/**
 * 052: tails the JCEF log files and hands back the GPU crash lines that
 * appeared since the last poll.
 *
 * Only NEW content is read: the first sight of a file records where it is and
 * never replays history, and afterwards the tail is read from that offset. A
 * partial last line is kept until its newline arrives, so a crash line split
 * across two polls is still counted.
 */
internal class GpuCrashLogTailer(
    private val dirs: List<File>,
    private val pid: Long,
) {

    private val offsets = HashMap<String, Long>()
    private val pending = HashMap<String, String>()

    /** GPU crash lines written since the previous call. */
    fun newGpuCrashLines(nowMs: Long): List<String> {
        val out = ArrayList<String>()
        for (candidate in GpuCrashLogFiles.discover(dirs, pid, nowMs)) {
            val file = File(candidate.path)
            val path = file.absolutePath
            val size = try {
                file.length()
            } catch (_: Throwable) {
                continue
            }
            val known = offsets[path]
            if (known == null) {
                // First sight: remember the position, never replay history.
                offsets[path] = size
                continue
            }
            if (size <= known) {
                offsets[path] = size
                continue
            }
            val chunk = try {
                readFrom(file, known, size)
            } catch (_: Throwable) {
                ""
            }
            offsets[path] = size

            val text = pending.remove(path).orEmpty() + chunk
            val lastBreak = text.lastIndexOf('\n')
            val complete = if (lastBreak >= 0) text.substring(0, lastBreak + 1) else ""
            val rest = if (lastBreak >= 0) text.substring(lastBreak + 1) else text
            if (rest.isNotEmpty()) pending[path] = rest
            complete.lineSequence().forEach { line ->
                if (GpuCrashPolicy.isGpuCrashLine(line)) out.add(line)
            }
        }
        return out
    }

    private fun readFrom(file: File, from: Long, to: Long): String {
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(from)
            val length = (to - from).coerceAtMost(MAX_READ_BYTES).toInt()
            if (length <= 0) return ""
            val buffer = ByteArray(length)
            raf.readFully(buffer)
            return String(buffer, Charsets.UTF_8)
        }
    }

    companion object {
        /** A single poll never reads more than this from one file. */
        private const val MAX_READ_BYTES = 8L * 1024 * 1024
    }
}
