package uk.eugnel.ks2spelling;

import android.content.Intent;
import android.system.Os;
import android.system.OsConstants;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONObject;

@CapacitorPlugin(name = "B3ProofObservation")
public final class B3ProofObservationPlugin extends Plugin {
    public static final String COMMAND_EXTRA =
        "uk.eugnel.ks2spelling.B3_PROOF_COMMAND_V1";
    private static final String OBSERVATION_FILENAME =
        "b3-proof-observation-v1.json";
    private static final int MAXIMUM_BYTES = 64 * 1024;
    private static final Set<String> OBSERVATION_KEYS = new HashSet<>(Arrays.asList(
        "schemaVersion", "platform", "buildAuthoritySha256", "captureId",
        "installationId", "sequence", "previousObservationSha256", "scenarioIndex",
        "scenario", "phase", "nextActionCode", "completedTransitions",
        "proofProjection", "observedAt", "observationSha256"
    ));

    @PluginMethod public void getLaunchCommand(PluginCall call) {
        try {
            require(BuildConfig.B3_SANDBOX_PROOF && call.getData().length() == 0);
            Intent intent = getActivity().getIntent();
            String value = intent == null ? null : intent.getStringExtra(COMMAND_EXTRA);
            JSObject result = new JSObject();
            if (value == null) {
                result.put("commandJson", JSONObject.NULL);
            } else {
                byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                require(bytes.length > 0 && bytes.length <= MAXIMUM_BYTES);
                result.put("commandJson", value);
            }
            call.resolve(result);
        } catch (Exception error) {
            reject(call);
        }
    }

    @PluginMethod public void publishObservation(PluginCall call) {
        File temporary = null;
        try {
            require(BuildConfig.B3_SANDBOX_PROOF);
            requireExactKeys(call.getData(), setOf("canonicalJson"));
            String canonicalJson = call.getString("canonicalJson");
            require(canonicalJson != null);
            byte[] bytes = canonicalJson.getBytes(StandardCharsets.UTF_8);
            require(bytes.length > 0 && bytes.length <= MAXIMUM_BYTES);
            validateClosedObservation(canonicalJson);

            File root = getContext().getExternalFilesDir(null);
            require(root != null && root.isDirectory());
            require(!Files.isSymbolicLink(root.toPath()));
            File destination = new File(root, OBSERVATION_FILENAME);
            assertSafeTarget(destination, false);

            temporary = File.createTempFile("b3-proof-observation-", ".tmp", root);
            require(temporary.getParentFile().getCanonicalFile().equals(root.getCanonicalFile()));
            require(!Files.isSymbolicLink(temporary.toPath()) && temporary.isFile());
            try (FileOutputStream output = new FileOutputStream(temporary, false)) {
                output.write(bytes);
                output.getFD().sync();
            }
            Files.move(
                temporary.toPath(),
                destination.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING
            );
            temporary = null;
            syncDirectory(root);
            assertSafeTarget(destination, true);
            JSObject result = new JSObject();
            result.put("written", true);
            call.resolve(result);
        } catch (Exception error) {
            if (temporary != null) temporary.delete();
            reject(call);
        }
    }

    private static void validateClosedObservation(String canonicalJson) throws Exception {
        JSONObject object = new JSONObject(canonicalJson);
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = object.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        require(keys.equals(OBSERVATION_KEYS) && object.length() == OBSERVATION_KEYS.size());
    }

    private static void assertSafeTarget(File target, boolean mustExist) throws Exception {
        require(OBSERVATION_FILENAME.equals(target.getName()));
        if (!target.exists()) {
            require(!mustExist);
            return;
        }
        require(!Files.isSymbolicLink(target.toPath()));
        require(target.isFile() && target.length() > 0 && target.length() <= MAXIMUM_BYTES);
    }

    private static void syncDirectory(File directory) throws Exception {
        FileDescriptor descriptor = Os.open(
            directory.getAbsolutePath(),
            OsConstants.O_RDONLY,
            0
        );
        try {
            Os.fsync(descriptor);
        } finally {
            Os.close(descriptor);
        }
    }

    private static void requireExactKeys(JSONObject object, Set<String> expected) throws Exception {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = object.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        require(keys.equals(expected) && object.length() == expected.size());
    }

    private static Set<String> setOf(String... values) {
        return new HashSet<>(Arrays.asList(values));
    }

    private static void require(boolean condition) throws Exception {
        if (!condition) throw new Exception("rejected");
    }

    private static void reject(PluginCall call) {
        call.reject("Proof observation rejected.", "B3_PROOF_OBSERVATION_REJECTED");
    }
}
