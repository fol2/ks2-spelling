package uk.eugnel.ks2spelling;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import android.content.Intent;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PackTransferPlugin.class);
        registerPlugin(CommercePlugin.class);
        if (BuildConfig.B3_SANDBOX_PROOF) {
            registerPlugin(BuildAuthorityPlugin.class);
            registerB3ProofObservationPlugin();
        }
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (BuildConfig.B3_SANDBOX_PROOF) setIntent(intent);
    }

    @SuppressWarnings("unchecked")
    private void registerB3ProofObservationPlugin() {
        try {
            Class<?> candidate = Class.forName(
                "uk.eugnel.ks2spelling.B3ProofObservationPlugin"
            );
            if (!Plugin.class.isAssignableFrom(candidate)) {
                throw new IllegalStateException("B3 proof observation plugin is invalid.");
            }
            registerPlugin((Class<? extends Plugin>) candidate);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("B3 proof observation plugin is unavailable.", error);
        }
    }
}
