package dev.pi.agent.editor

import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes

/**
 * Summary of one directory for "Add Directory to Pi" (spec 009 US3):
 * the entry list handed to the composer, plus honest truncation bookkeeping.
 */
data class DirectoryListing(
    /** Display path of the walked root: project-relative when possible, else absolute. */
    val root: String,
    /** Listed paths (files and directories), relative to the project when inside it. */
    val entries: List<String>,
    val fileCount: Int,
    val dirCount: Int,
    /** Entries left out because the output cap [Limits.maxOutput] was reached. */
    val omitted: Int,
    /** The walk itself hit the depth or entry cap — entries below are missing entirely. */
    val truncated: Boolean,
)

data class Limits(
    /** Entries the walk may visit before stopping (protects huge trees). */
    val maxEntries: Int = 5_000,
    /** Directory levels to descend (spec FR-008: ≤12). */
    val maxDepth: Int = 12,
    /** Entry lines actually put into the prompt (spec FR-008: ≤200). */
    val maxOutput: Int = 200,
)

/** Directory names never listed (mirrors the file-index exclusions in BridgeService). */
val EXCLUDED_DIR_NAMES: Set<String> = setOf(
    "node_modules", "build", "out", "dist", "target",
    ".git", ".idea", ".gradle", "vendor",
)

private class WalkCapReached : RuntimeException()

/**
 * Walks [root] and produces the listing. Never follows symbolic links and
 * skips unreadable entries instead of failing (FR-009). The walk runs on the
 * caller's thread — the action must invoke this off the EDT (FR-008).
 */
fun listDirectory(root: Path, projectRoot: Path?, limits: Limits = Limits()): DirectoryListing {
    if (!Files.isDirectory(root)) {
        return DirectoryListing(displayPath(root, projectRoot), emptyList(), 0, 0, 0, truncated = false)
    }

    val collected = mutableListOf<Path>()
    var fileCount = 0
    var dirCount = 0
    var truncated = false
    var visited = 0

    val visitor = object : SimpleFileVisitor<Path>() {
        private fun checkCap() {
            if (++visited > limits.maxEntries) throw WalkCapReached()
        }

    override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
        if (dir == root) return FileVisitResult.CONTINUE
        checkCap()
        if (dir.fileName?.toString() in EXCLUDED_DIR_NAMES) return FileVisitResult.SKIP_SUBTREE
        // depthOf is relative to the walked root: L1 is level 1. Anything past
        // the limit proves the listing is truncated (it is not collected).
        if (depthOf(dir, root) > limits.maxDepth) {
            truncated = true
            return FileVisitResult.SKIP_SUBTREE
        }
        dirCount++
        collected.add(dir)
        return FileVisitResult.CONTINUE
    }

        override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
            checkCap()
            if (attrs.isSymbolicLink) return FileVisitResult.CONTINUE // never follow (FR-009)
            fileCount++
            collected.add(file)
            return FileVisitResult.CONTINUE
        }

        override fun visitFileFailed(file: Path, e: java.io.IOException?): FileVisitResult {
            // Unreadable entries are skipped, not fatal (FR-009).
            truncated = true
            return FileVisitResult.CONTINUE
        }
    }

    try {
        // walkFileTree counts the start directory itself as level 1, so the
        // walk must go two levels past the limit: one to reach the first
        // too-deep directory, one to prove there was more below it.
        Files.walkFileTree(root, emptySet(), limits.maxDepth + 2, visitor)
    } catch (_: WalkCapReached) {
        truncated = true
    }

    val display = displayPath(root, projectRoot)
    fun relative(p: Path): String =
        if (projectRoot != null && p.startsWith(projectRoot)) displayPath(p, projectRoot) else p.toString()

    val sorted = collected.map { relative(it) }.sorted()
    val listed = sorted.take(limits.maxOutput)
    return DirectoryListing(
        root = display,
        entries = listed,
        fileCount = fileCount,
        dirCount = dirCount,
        omitted = sorted.size - listed.size,
        truncated = truncated,
    )
}

private fun depthOf(p: Path, root: Path): Int = root.relativize(p).nameCount

private fun displayPath(p: Path, projectRoot: Path?): String {
    val rel = projectRoot?.takeIf { p.startsWith(it) }?.let { runCatching { it.relativize(p) }.getOrNull() }
    return (rel ?: p).toString().replace('\\', '/')
}
