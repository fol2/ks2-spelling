package uk.eugnel.ks2spelling;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

@CapacitorPlugin(name = "ParentAccess")
public final class ParentAccessPlugin extends Plugin {
    private static final int AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_STRONG;
    private final AtomicBoolean authenticationInFlight = new AtomicBoolean(false);

    @PluginMethod
    public void getBiometricAvailability(PluginCall call) {
        if (!exactKeys(call.getData(), new HashSet<>())) {
            reject(call);
            return;
        }
        boolean available = BiometricManager.from(getContext())
            .canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS;
        JSObject result = new JSObject();
        result.put("available", available);
        result.put("type", available ? "biometric" : "none");
        call.resolve(result);
    }

    @PluginMethod
    public void authenticateBiometric(PluginCall call) {
        if (!exactKeys(call.getData(), setOf("reason"))) {
            reject(call);
            return;
        }
        String reason = call.getString("reason");
        if (
            reason == null
                || reason.isEmpty()
                || reason.getBytes(StandardCharsets.UTF_8).length > 120
        ) {
            reject(call);
            return;
        }
        if (
            BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS)
                != BiometricManager.BIOMETRIC_SUCCESS
        ) {
            reject(call);
            return;
        }
        if (!authenticationInFlight.compareAndSet(false, true)) {
            reject(call);
            return;
        }
        if (!(getActivity() instanceof FragmentActivity)) {
            authenticationInFlight.set(false);
            reject(call);
            return;
        }
        FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(() -> showPrompt(activity, call, reason));
    }

    private void showPrompt(
        FragmentActivity activity,
        PluginCall call,
        String reason
    ) {
        Executor executor = ContextCompat.getMainExecutor(getContext());
        BiometricPrompt prompt = new BiometricPrompt(
            activity,
            executor,
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationError(
                    int errorCode,
                    CharSequence errorText
                ) {
                    authenticationInFlight.set(false);
                    reject(call);
                }

                @Override
                public void onAuthenticationSucceeded(
                    BiometricPrompt.AuthenticationResult result
                ) {
                    authenticationInFlight.set(false);
                    JSObject response = new JSObject();
                    response.put("authenticated", true);
                    call.resolve(response);
                }
            }
        );
        BiometricPrompt.PromptInfo promptInfo =
            new BiometricPrompt.PromptInfo.Builder()
                .setTitle(reason)
                .setSubtitle("Confirm that you are an adult")
                .setAllowedAuthenticators(AUTHENTICATORS)
                .setNegativeButtonText("Cancel")
                .build();
        prompt.authenticate(promptInfo);
    }

    @Override
    protected void handleOnDestroy() {
        authenticationInFlight.set(false);
        super.handleOnDestroy();
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
        call.reject(
            "Parent biometric authentication rejected.",
            "PARENT_BIOMETRICS_REJECTED"
        );
    }
}
