package uk.eugnel.ks2spelling;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.Build;
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
    private static final int BIOMETRIC_AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_STRONG;
    private static final int DEVICE_OWNER_AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_STRONG
            | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    // Quick unlock and PIN bootstrap/recovery are one native authority surface:
    // two prompts may never race each other.
    private final AtomicBoolean authenticationInFlight = new AtomicBoolean(false);

    @PluginMethod
    public void getBiometricAvailability(PluginCall call) {
        if (!exactKeys(call.getData(), new HashSet<>())) {
            rejectBiometric(call);
            return;
        }
        boolean available = BiometricManager.from(getContext())
            .canAuthenticate(BIOMETRIC_AUTHENTICATORS)
            == BiometricManager.BIOMETRIC_SUCCESS;
        JSObject result = new JSObject();
        result.put("available", available);
        result.put("type", available ? "biometric" : "none");
        call.resolve(result);
    }

    @PluginMethod
    public void authenticateBiometric(PluginCall call) {
        String reason = requireReason(call);
        if (reason == null) {
            rejectBiometric(call);
            return;
        }
        if (
            BiometricManager.from(getContext())
                .canAuthenticate(BIOMETRIC_AUTHENTICATORS)
                != BiometricManager.BIOMETRIC_SUCCESS
        ) {
            rejectBiometric(call);
            return;
        }
        if (!beginAuthentication(call, true)) return;
        FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(
            () -> showPrompt(activity, call, reason, false)
        );
    }

    @PluginMethod
    public void getDeviceOwnerAuthenticationAvailability(PluginCall call) {
        if (!exactKeys(call.getData(), new HashSet<>())) {
            rejectDeviceOwner(call);
            return;
        }
        JSObject result = new JSObject();
        result.put("available", deviceOwnerAuthenticationAvailable());
        call.resolve(result);
    }

    @PluginMethod
    public void authenticateDeviceOwner(PluginCall call) {
        String reason = requireReason(call);
        if (reason == null || !deviceOwnerAuthenticationAvailable()) {
            rejectDeviceOwner(call);
            return;
        }
        if (!beginAuthentication(call, false)) return;
        FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(
            () -> showPrompt(activity, call, reason, true)
        );
    }

    private boolean beginAuthentication(
        PluginCall call,
        boolean biometricOnly
    ) {
        if (!authenticationInFlight.compareAndSet(false, true)) {
            if (biometricOnly) rejectBiometric(call);
            else rejectDeviceOwner(call);
            return false;
        }
        if (!(getActivity() instanceof FragmentActivity)) {
            authenticationInFlight.set(false);
            if (biometricOnly) rejectBiometric(call);
            else rejectDeviceOwner(call);
            return false;
        }
        return true;
    }

    private boolean deviceOwnerAuthenticationAvailable() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return BiometricManager.from(getContext())
                .canAuthenticate(DEVICE_OWNER_AUTHENTICATORS)
                == BiometricManager.BIOMETRIC_SUCCESS;
        }
        // AndroidX cannot reliably query DEVICE_CREDENTIAL through
        // canAuthenticate() before API 30. The platform's secure-keyguard bit
        // is the supported compatibility oracle for this repository's API-24
        // floor; the prompt below uses setDeviceCredentialAllowed(true).
        KeyguardManager keyguard = (KeyguardManager) getContext()
            .getSystemService(Context.KEYGUARD_SERVICE);
        return keyguard != null && keyguard.isDeviceSecure();
    }

    private void showPrompt(
        FragmentActivity activity,
        PluginCall call,
        String reason,
        boolean allowDeviceCredential
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
                    if (allowDeviceCredential) rejectDeviceOwner(call);
                    else rejectBiometric(call);
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
        BiometricPrompt.PromptInfo.Builder builder =
            new BiometricPrompt.PromptInfo.Builder()
                .setTitle(reason)
                .setSubtitle(
                    allowDeviceCredential
                        ? "Confirm the device owner"
                        : "Confirm that you are an adult"
                );
        if (allowDeviceCredential) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setAllowedAuthenticators(
                    DEVICE_OWNER_AUTHENTICATORS
                );
            } else {
                builder.setDeviceCredentialAllowed(true);
            }
        } else {
            builder
                .setAllowedAuthenticators(BIOMETRIC_AUTHENTICATORS)
                .setNegativeButtonText("Cancel");
        }
        prompt.authenticate(builder.build());
    }

    @Override
    protected void handleOnDestroy() {
        authenticationInFlight.set(false);
        super.handleOnDestroy();
    }

    private static String requireReason(PluginCall call) {
        if (!exactKeys(call.getData(), setOf("reason"))) return null;
        String reason = call.getString("reason");
        if (
            reason == null
                || reason.isEmpty()
                || reason.getBytes(StandardCharsets.UTF_8).length > 120
        ) {
            return null;
        }
        return reason;
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

    private static void rejectBiometric(PluginCall call) {
        call.reject(
            "Parent biometric authentication rejected.",
            "PARENT_BIOMETRICS_REJECTED"
        );
    }

    private static void rejectDeviceOwner(PluginCall call) {
        call.reject(
            "Parent device-owner authentication rejected.",
            "PARENT_DEVICE_AUTHENTICATION_REJECTED"
        );
    }
}
