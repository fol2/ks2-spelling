package uk.eugnel.ks2spelling;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "BuildAuthority")
public final class BuildAuthorityPlugin extends Plugin {
    private static final Pattern COMMIT = Pattern.compile("^[0-9a-f]{40}$");
    private static final Pattern HASH = Pattern.compile("^[0-9a-f]{64}$");

    @PluginMethod public void getAuthority(PluginCall call) {
        if (!COMMIT.matcher(BuildConfig.B3_TESTED_APPLICATION_COMMIT).matches()
            || !HASH.matcher(BuildConfig.B3_APPLICATION_FINGERPRINT).matches()
            || !"0.3.0-b3".equals(BuildConfig.VERSION_NAME)
            || BuildConfig.VERSION_CODE <= 0) {
            call.reject("BUILD_AUTHORITY_INVALID");
            return;
        }
        JSObject value = new JSObject();
        value.put("mode", "B3SandboxProof");
        value.put("proofKind", "physical-live");
        value.put("platform", "android");
        value.put("distribution", "play-internal");
        value.put("publicSandboxOrigin", "https://b3-gateway.eugnel.uk");
        value.put("workerName", "ks2-spelling-b3-sandbox");
        value.put("bundleId", BuildConfig.APPLICATION_ID);
        value.put("testedApplicationCommit", BuildConfig.B3_TESTED_APPLICATION_COMMIT);
        value.put("applicationFingerprint", BuildConfig.B3_APPLICATION_FINGERPRINT);
        value.put("versionName", BuildConfig.VERSION_NAME);
        value.put("buildNumber", BuildConfig.VERSION_CODE);
        call.resolve(value);
    }
}
