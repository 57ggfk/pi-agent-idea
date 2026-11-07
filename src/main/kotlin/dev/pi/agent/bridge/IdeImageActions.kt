package dev.pi.agent.bridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.awt.Image
import java.awt.Toolkit
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.Transferable
import java.awt.datatransfer.UnsupportedFlavorException
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.util.Base64
import javax.imageio.ImageIO

/**
 * Image save/copy for the preview modal (012 US7, T137).
 *
 * JCEF has no async clipboard API and no way to hand a blob to the OS save
 * dialog (see web/src/lib/clipboard.ts), so the two "share this image"
 * actions cross the bridge into IDEA: `ide.saveImage` opens the platform save
 * dialog and writes the bytes, `ide.copyImage` puts the decoded image on the
 * system clipboard. Failures are returned — the UI must show them, never
 * pretend success (clipboard.ts contract). Cancelling writes nothing.
 */
object IdeImageActions {

    fun saveImage(project: Project, params: JsonObject): JsonObject {
        val (decoded, failure) = decode(params)
        if (failure != null) return failure
        val bytes = decoded!!
        val suggested = (params["suggestedName"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
            ?: "image.png"
        val ext = suggested.substringAfterLast('.', "png")

        var result: JsonObject? = null
        ApplicationManager.getApplication().invokeAndWait {
            val dialog = FileChooserFactory.getInstance()
                .createSaveFileDialog(FileSaverDescriptor("Save Image", "Choose where to save the image", ext), project)
            val wrapper = dialog.save(null as com.intellij.openapi.vfs.VirtualFile?, suggested)
            result = when {
                wrapper?.getFile() == null ->
                    buildJsonObject {
                        put("ok", false)
                        put("cancelled", true)
                        put("error", "save cancelled")
                    }
                else -> {
                    val target = wrapper!!.getFile().toPath()
                    try {
                        java.nio.file.Files.write(target, bytes)
                        buildJsonObject { put("ok", true); put("path", target.toString()) }
                    } catch (e: Exception) {
                        buildJsonObject { put("ok", false); put("error", e.message ?: "could not write the file") }
                    }
                }
            }
        }
        return result ?: error("save dialog did not run")
    }

    fun copyImage(params: JsonObject): JsonObject {
        val (decoded, failure) = decode(params)
        if (failure != null) return failure
        return try {
            val image: BufferedImage? = ImageIO.read(ByteArrayInputStream(decoded))
            if (image == null) {
                error("the attachment is not a decodable image")
            } else {
                ApplicationManager.getApplication().invokeAndWait {
                    val clipboard = Toolkit.getDefaultToolkit().systemClipboard
                    clipboard.setContents(ImageTransferable(image), null)
                }
                buildJsonObject { put("ok", true) }
            }
        } catch (e: Exception) {
            error("could not copy the image: ${e.message}")
        }
    }

    private fun decode(params: JsonObject): Pair<ByteArray?, JsonObject?> {
        val data = (params["data"] as? JsonPrimitive)?.content
            ?: return null to error("missing image data")
        val base64 = if (data.startsWith("data:")) data.substringAfter(',', "") else data
        if (base64.isEmpty()) return null to error("empty image data")
        return try {
            Base64.getDecoder().decode(base64) to null
        } catch (e: IllegalArgumentException) {
            null to error("image data is not valid base64")
        }
    }

    private fun error(message: String): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", message)
    }
}

/** AWT clipboard adapter: exposes the BufferedImage under imageFlavor. */
private class ImageTransferable(private val image: Image) : Transferable {
    override fun getTransferDataFlavors(): Array<DataFlavor> = arrayOf(DataFlavor.imageFlavor)
    override fun isDataFlavorSupported(flavor: DataFlavor): Boolean = flavor == DataFlavor.imageFlavor
    override fun getTransferData(flavor: DataFlavor): Any {
        if (flavor != DataFlavor.imageFlavor) throw UnsupportedFlavorException(flavor)
        return image
    }
}
