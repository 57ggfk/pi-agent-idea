package probe;

import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;

/** Appends probe output to a fixed file outside any IDE install. */
public final class ProbeLog {
    private static final Path OUT = Paths.get("D:/code/probe-042/plugin-results.log");
    private static boolean headerWritten = false;

    private ProbeLog() {}

    public static synchronized void line(String s) {
        try {
            Files.createDirectories(OUT.getParent());
            boolean append = headerWritten || Files.exists(OUT);
            if (!headerWritten) {
                try (FileWriter w = new FileWriter(OUT.toFile(), append)) {
                    if (!append) w.write("=== jcef-probe run " + LocalDateTime.now() + " ===\n");
                    else w.write("\n=== re-run " + LocalDateTime.now() + " ===\n");
                }
                headerWritten = true;
            }
            try (FileWriter w = new FileWriter(OUT.toFile(), true)) {
                w.write(LocalDateTime.now().toLocalTime() + " " + s + "\n");
            }
        } catch (IOException ignored) {
        }
        System.out.println("JCEF-PROBE: " + s);
    }
}
