package uk.eugnel.ks2spelling;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.json.JSONObject;

@CapacitorPlugin(name = "LearningBackupFile")
public final class LearningBackupFilePlugin extends Plugin {
    private static final int MAXIMUM_BYTES = 5 * 1024 * 1024;
    private static final String EXPORT_ROOT = "learning-backups";
    private static final Pattern FILE_NAME = Pattern.compile(
        "^ks2-spelling-backup-[0-9]{8}-[0-9]{6}\\.json$"
    );
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern BASE64 = Pattern.compile(
        "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
    );

    @PluginMethod
    public void presentExport(PluginCall call) {
        if (
            !exactKeys(
                call.getData(),
                setOf("fileName", "bytesBase64", "sha256")
            )
        ) {
            reject(call);
            return;
        }
        String fileName = call.getString("fileName");
        String bytesBase64 = call.getString("bytesBase64");
        String expectedHash = call.getString("sha256");
        byte[] bytes = decodeBoundedBase64(bytesBase64);
        if (
            fileName == null
                || !FILE_NAME.matcher(fileName).matches()
                || expectedHash == null
                || !SHA256.matcher(expectedHash).matches()
                || bytes == null
                || !MessageDigest.isEqual(
                    expectedHash.getBytes(StandardCharsets.US_ASCII),
                    sha256(bytes).getBytes(StandardCharsets.US_ASCII)
                )
        ) {
            reject(call);
            return;
        }

        try {
            File directory = prepareExportDirectory();
            File target = new File(directory, fileName);
            File temporary = new File(directory, fileName + ".tmp");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.getFD().sync();
            }
            if (!temporary.renameTo(target)) {
                throw new IOException("Learning backup rename failed.");
            }
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                target
            );
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("application/json");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.setClipData(ClipData.newRawUri("learning-backup", uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(
                Intent.createChooser(send, "Save learning backup")
            );
            JSObject result = new JSObject();
            result.put("presented", true);
            call.resolve(result);
        } catch (IOException | RuntimeException error) {
            reject(call, error);
        }
    }

    @PluginMethod
    public void pickImport(PluginCall call) {
        Integer maximumBytes = call.getInt("maximumBytes");
        if (
            !exactKeys(call.getData(), setOf("maximumBytes"))
                || maximumBytes == null
                || maximumBytes != MAXIMUM_BYTES
        ) {
            reject(call);
            return;
        }
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("application/json");
        startActivityForResult(call, pick, "pickedImport");
    }

    @ActivityCallback
    private void pickedImport(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_CANCELED) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        Intent intent = result.getData();
        if (
            result.getResultCode() != Activity.RESULT_OK
                || intent == null
                || intent.getData() == null
        ) {
            reject(call);
            return;
        }
        try {
            byte[] bytes = readBounded(intent.getData());
            JSObject imported = new JSObject();
            imported.put("cancelled", false);
            imported.put(
                "bytesBase64",
                Base64.encodeToString(bytes, Base64.NO_WRAP)
            );
            imported.put("sha256", sha256(bytes));
            call.resolve(imported);
        } catch (IOException | RuntimeException error) {
            reject(call, error);
        }
    }

    private File prepareExportDirectory() throws IOException {
        File root = new File(getContext().getCacheDir(), EXPORT_ROOT);
        clearControlledRoot(root);
        if (!root.exists() && !root.mkdir()) {
            throw new IOException("Learning backup cache root is unavailable.");
        }
        File directory = new File(root, UUID.randomUUID().toString());
        if (!directory.mkdir()) {
            throw new IOException("Learning backup cache is unavailable.");
        }
        return directory;
    }

    private static void clearControlledRoot(File root) throws IOException {
        if (!root.exists()) return;
        File[] directories = root.listFiles();
        if (directories == null) {
            throw new IOException("Learning backup cache cannot be inspected.");
        }
        for (File directory : directories) {
            File[] files = directory.listFiles();
            if (files == null) {
                throw new IOException("Learning backup cache is invalid.");
            }
            for (File file : files) {
                if (!file.delete()) {
                    throw new IOException("Learning backup cache file remains.");
                }
            }
            if (!directory.delete()) {
                throw new IOException("Learning backup cache remains.");
            }
        }
    }

    private byte[] readBounded(Uri uri) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        try (
            Cursor cursor = resolver.query(
                uri,
                new String[] { OpenableColumns.SIZE },
                null,
                null,
                null
            )
        ) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                long size = cursor.getLong(0);
                if (size < 2 || size > MAXIMUM_BYTES) {
                    throw new IOException("Learning backup size is invalid.");
                }
            }
        }
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) {
                throw new IOException("Learning backup cannot be opened.");
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            int total = 0;
            int count;
            while ((count = input.read(chunk)) != -1) {
                if (count == 0) continue;
                total += count;
                if (total > MAXIMUM_BYTES) {
                    throw new IOException("Learning backup is too large.");
                }
                output.write(chunk, 0, count);
            }
            if (total < 2) {
                throw new IOException("Learning backup is empty.");
            }
            return output.toByteArray();
        }
    }

    private static byte[] decodeBoundedBase64(String value) {
        if (
            value == null
                || value.isEmpty()
                || value.length() > 4 * ((MAXIMUM_BYTES + 2) / 3)
                || !BASE64.matcher(value).matches()
        ) {
            return null;
        }
        try {
            byte[] bytes = Base64.decode(value, Base64.NO_WRAP);
            if (
                bytes.length < 2
                    || bytes.length > MAXIMUM_BYTES
                    || !Base64.encodeToString(bytes, Base64.NO_WRAP)
                        .equals(value)
            ) {
                return null;
            }
            return bytes;
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder value = new StringBuilder(64);
            for (byte item : digest) {
                value.append(String.format("%02x", item & 0xff));
            }
            return value.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable.", error);
        }
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

    private static void reject(PluginCall call) {
        reject(call, null);
    }

    private static void reject(PluginCall call, Exception error) {
        call.reject(
            "Learning backup file operation rejected.",
            "LEARNING_BACKUP_FILE_REJECTED",
            error
        );
    }
}
