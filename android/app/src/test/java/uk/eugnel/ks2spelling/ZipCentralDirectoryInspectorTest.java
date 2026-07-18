package uk.eugnel.ks2spelling;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class ZipCentralDirectoryInspectorTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private static ZipCentralDirectoryInspector.ManifestInventory manifest() {
        return new ZipCentralDirectoryInspector.ManifestInventory(
            1, 1324, 16, 1_048_576, 4_194_304,
            List.of(".json", ".m4a"),
            List.of(
                new ZipCentralDirectoryInspector.FileDeclaration(
                    "audio/proof-word.m4a", 840,
                    "ef93d2c71f8490c7dd1b93929d8cba78b82c7c22c7c5da210e402be0f6b3f82f"
                ),
                new ZipCentralDirectoryInspector.FileDeclaration(
                    "catalogue.json", 242,
                    "ee99faa101efe4e18e6e864f4b9265eabc8f0106dd72465c7c4fc3c1b36feb3e"
                )
            )
        );
    }

    @Test public void acceptsCanonicalProofPack() throws Exception {
        File archive = resourceToFile("b3-sandbox-proof.zip");
        byte[] archiveBytes = Files.readAllBytes(archive.toPath());
        ZipCentralDirectoryInspector.Inventory inventory =
            ZipCentralDirectoryInspector.inspect(archiveBytes, manifest());
        assertEquals(2, inventory.entries.size());
        assertEquals(1082, inventory.extractedBytes);
        List<String> extracted = new ArrayList<>();
        int extractedBytes = ZipCentralDirectoryInspector.consumeVerifiedEntries(
            archiveBytes, inventory, manifest().extractedBytesCeiling,
            (entry, content) -> extracted.add(entry.path + ":" + content.length)
        );
        assertEquals(1082, extractedBytes);
        assertEquals(List.of("audio/proof-word.m4a:840", "catalogue.json:242"), extracted);
    }

    @Test public void verifiedBytesRemainAuthorityAfterSourcePathReplacement() throws Exception {
        File archive = resourceToFile("b3-sandbox-proof.zip");
        byte[] verifiedBytes = Files.readAllBytes(archive.toPath());
        ZipCentralDirectoryInspector.Inventory inventory =
            ZipCentralDirectoryInspector.inspect(verifiedBytes, manifest());
        Path replacement = temporary.newFile("replacement.zip").toPath();
        Files.write(replacement, "not the inspected archive".getBytes(StandardCharsets.UTF_8));
        Files.delete(archive.toPath());
        try {
            Files.createSymbolicLink(archive.toPath(), replacement);
        } catch (UnsupportedOperationException | java.io.IOException unavailable) {
            Files.write(archive.toPath(), Files.readAllBytes(replacement));
        }
        assertFalse(java.util.Arrays.equals(verifiedBytes, Files.readAllBytes(archive.toPath())));

        List<String> extracted = new ArrayList<>();
        ZipCentralDirectoryInspector.consumeVerifiedEntries(
            verifiedBytes, inventory, manifest().extractedBytesCeiling,
            (entry, content) -> extracted.add(entry.path)
        );
        assertEquals(List.of("audio/proof-word.m4a", "catalogue.json"), extracted);
    }

    @Test public void rejectsEveryCanonicalHostileByteFixture() throws Exception {
        String authority = resourceText("b3-hostile-zips/manifest.json");
        Matcher matcher = Pattern.compile("\\\"file\\\"\\s*:\\s*\\\"([^\\\"]+\\.zip)\\\"").matcher(authority);
        List<String> fixtures = new ArrayList<>();
        while (matcher.find()) fixtures.add(matcher.group(1));
        assertEquals(53, fixtures.size());
        for (String fixture : fixtures) {
            try {
                ZipCentralDirectoryInspector.inspect(
                    resourceBytes("b3-hostile-zips/" + fixture), manifest()
                );
                fail("Accepted hostile fixture " + fixture);
            } catch (java.io.IOException expected) {
                // Rejection is the contract.
            }
        }
    }

    private byte[] resourceBytes(String name) throws Exception {
        try (InputStream input = getClass().getClassLoader().getResourceAsStream(name)) {
            if (input == null) throw new AssertionError("Missing resource " + name);
            return input.readAllBytes();
        }
    }

    private File resourceToFile(String name) throws Exception {
        File output = temporary.newFile(name.replace('/', '-'));
        try (InputStream input = getClass().getClassLoader().getResourceAsStream(name);
             FileOutputStream stream = new FileOutputStream(output)) {
            if (input == null) throw new AssertionError("Missing resource " + name);
            input.transferTo(stream);
        }
        return output;
    }

    private String resourceText(String name) throws Exception {
        try (InputStream input = getClass().getClassLoader().getResourceAsStream(name)) {
            if (input == null) throw new AssertionError("Missing resource " + name);
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
