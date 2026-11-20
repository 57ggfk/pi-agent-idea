package dev.pi.agent.browser

/**
 * Finds Chromium's GPU child process of THIS IDE.
 *
 * The IDE JVM owns the JCEF server process (`cef_server.exe`), which in turn
 * owns the GPU process (`cef_server.exe --type=gpu-process`) — verified on
 * 2026.2.3: IDE PID 43940 -> cef_server 35528 -> gpu-process 40556. Two hops
 * is the real depth; three leaves room for one extra wrapper.
 */
internal object GpuProcessScanner {

    /** IDE JVM -> JCEF server -> GPU process is two hops. */
    const val MAX_DEPTH = 3

    /** Pure part: which of these processes are GPU processes. */
    fun gpuPids(samples: List<Pair<Long, String?>>): Set<Long> =
        samples.filter { GpuCrashPolicy.isGpuProcess(it.second) }.map { it.first }.toSet()

    /**
     * Live scan of the GPU processes below [root] (the IDE JVM by default).
     *
     * A dead or unreadable process contributes nothing — the scan never
     * throws, because a failed probe must not take the watcher down.
     */
    fun liveGpuPids(root: ProcessHandle = ProcessHandle.current()): Set<Long> {
        val samples = ArrayList<Pair<Long, String?>>()
        val queue = ArrayDeque<Pair<ProcessHandle, Int>>()
        queue.add(root to 0)
        while (queue.isNotEmpty()) {
            val (handle, depth) = queue.removeFirst()
            if (depth >= MAX_DEPTH) continue
            val children = handle.children()
            try {
                children.forEach { child ->
                    val commandLine = try {
                        child.info().commandLine().orElse(null)
                    } catch (_: Throwable) {
                        null
                    }
                    samples.add(child.pid() to commandLine)
                    queue.add(child to depth + 1)
                }
            } finally {
                children.close()
            }
        }
        return gpuPids(samples)
    }
}
