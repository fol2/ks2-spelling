package uk.eugnel.ks2spelling;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PackTransferPlugin.class);
        registerPlugin(CommercePlugin.class);
        if (BuildConfig.B3_SANDBOX_PROOF) {
            registerPlugin(BuildAuthorityPlugin.class);
        }
        super.onCreate(savedInstanceState);
    }
}
