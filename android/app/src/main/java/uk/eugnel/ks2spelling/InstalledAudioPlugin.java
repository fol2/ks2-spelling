package uk.eugnel.ks2spelling;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileDescriptor;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONObject;

@CapacitorPlugin(name = "InstalledAudio")
public final class InstalledAudioPlugin extends Plugin {
    private static final int MAXIMUM_AUDIO_BYTES = 131_072;
    private static final Pattern SAFE_IDENTIFIER =
        Pattern.compile("^[a-z0-9][a-z0-9._-]{0,63}$");
    private static final Pattern SAFE_AUDIO_PATH = Pattern.compile(
        "^audio/(iapetus|sulafat)/[a-z0-9][a-z0-9._-]{0,63}/"
            + "(word|sentence-[0-9]{2}-(normal|slow))\\.m4a$"
    );
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void readInstalledAudio(PluginCall call) {
        if (!exactKeys(
            call.getData(),
            setOf("packId", "version", "assetPath", "sha256", "byteSize")
        )) {
            call.reject("Installed audio rejected.", "INSTALLED_AUDIO_REJECTED");
            return;
        }
        worker.execute(() -> {
            try {
                String packId = requiredString(call, "packId", 64);
                String version = requiredString(call, "version", 64);
                String assetPath = requiredString(call, "assetPath", 256);
                String expectedSha256 = requiredString(call, "sha256", 64);
                Integer expectedBytes = call.getInt("byteSize");
                require(SAFE_IDENTIFIER.matcher(packId).matches());
                require(SAFE_IDENTIFIER.matcher(version).matches());
                require(SAFE_AUDIO_PATH.matcher(assetPath).matches());
                require(SHA256.matcher(expectedSha256).matches());
                require(
                    expectedBytes != null
                        && expectedBytes > 0
                        && expectedBytes <= MAXIMUM_AUDIO_BYTES
                );

                File filesRoot = getContext().getFilesDir();
                File applicationRoot = new File(filesRoot, "ks2-spelling");
                File packRoot = new File(applicationRoot, "packs");
                File installedRoot = new File(packRoot, "installed");
                File packDirectory = new File(installedRoot, packId);
                File versionDirectory = new File(packDirectory, version);
                requireDirectoryChain(Arrays.asList(
                    filesRoot,
                    applicationRoot,
                    packRoot,
                    installedRoot,
                    packDirectory,
                    versionDirectory
                ));

                byte[] markerBytes = readRegularFile(
                    new File(versionDirectory, "activation.json"),
                    null,
                    16_384
                );
                JSONObject marker = new JSONObject(
                    new String(markerBytes, StandardCharsets.UTF_8)
                );
                require(exactKeys(marker, setOf("manifestSha256", "packId", "version")));
                require(packId.equals(marker.getString("packId")));
                require(version.equals(marker.getString("version")));
                String manifestSha256 = marker.getString("manifestSha256");
                require(SHA256.matcher(manifestSha256).matches());
                require(Arrays.equals(
                    markerBytes,
                    activationMarker(manifestSha256, packId, version)
                ));

                File extracted = new File(versionDirectory, "extracted");
                List<File> directories = new ArrayList<>();
                directories.add(extracted);
                File current = extracted;
                String[] components = assetPath.split("/", -1);
                require(components.length >= 2);
                for (int index = 0; index < components.length - 1; index += 1) {
                    current = new File(current, components[index]);
                    directories.add(current);
                }
                requireDirectoryChain(directories);
                File asset = new File(current, components[components.length - 1]);
                byte[] bytes = readRegularFile(
                    asset,
                    expectedBytes,
                    MAXIMUM_AUDIO_BYTES
                );
                require(expectedSha256.equals(sha256(bytes)));
                JSObject result = new JSObject();
                result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Installed audio rejected.", "INSTALLED_AUDIO_REJECTED");
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        worker.shutdownNow();
        super.handleOnDestroy();
    }

    private static void requireDirectoryChain(List<File> directories) throws Exception {
        for (File directory : directories) {
            StructStat stat;
            try {
                stat = Os.lstat(directory.getAbsolutePath());
            } catch (ErrnoException error) {
                throw rejected(error);
            }
            require((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFDIR);
        }
    }

    private static byte[] readRegularFile(
        File file,
        Integer expectedBytes,
        int maximumBytes
    ) throws Exception {
        FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(
                file.getAbsolutePath(),
                OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW,
                0
            );
            StructStat stat = Os.fstat(descriptor);
            require((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFREG);
            require(
                stat.st_size >= 0
                    && stat.st_size <= maximumBytes
                    && stat.st_size <= Integer.MAX_VALUE
                    && (expectedBytes == null || stat.st_size == expectedBytes)
            );
            byte[] result = new byte[(int) stat.st_size];
            int offset = 0;
            while (offset < result.length) {
                int count = Os.read(
                    descriptor,
                    result,
                    offset,
                    result.length - offset
                );
                require(count > 0);
                offset += count;
            }
            byte[] sentinel = new byte[1];
            require(Os.read(descriptor, sentinel, 0, 1) == 0);
            return result;
        } catch (ErrnoException error) {
            throw rejected(error);
        } finally {
            if (descriptor != null) {
                try {
                    Os.close(descriptor);
                } catch (ErrnoException ignored) {
                    // The read result has already been decided.
                }
            }
        }
    }

    private static String requiredString(
        PluginCall call,
        String key,
        int maximumBytes
    ) throws Exception {
        String value = call.getString(key);
        require(
            value != null
                && !value.isEmpty()
                && value.getBytes(StandardCharsets.UTF_8).length <= maximumBytes
        );
        return value;
    }

    private static byte[] activationMarker(
        String manifestSha256,
        String packId,
        String version
    ) {
        return (
            "{\"manifestSha256\":" + JSONObject.quote(manifestSha256)
                + ",\"packId\":" + JSONObject.quote(packId)
                + ",\"version\":" + JSONObject.quote(version) + "}\n"
        ).getBytes(StandardCharsets.UTF_8);
    }

    private static String sha256(byte[] value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
        StringBuilder result = new StringBuilder(digest.length * 2);
        for (byte entry : digest) {
            result.append(String.format(Locale.ROOT, "%02x", entry & 0xff));
        }
        return result.toString();
    }

    private static boolean exactKeys(JSONObject value, Set<String> expected) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) actual.add(keys.next());
        return actual.equals(expected) && value.length() == expected.size();
    }

    private static Set<String> setOf(String... values) {
        return new HashSet<>(Arrays.asList(values));
    }

    private static void require(boolean condition) throws Exception {
        if (!condition) throw rejected(null);
    }

    private static Exception rejected(Exception cause) {
        return new Exception("Installed audio rejected.", cause);
    }
}
