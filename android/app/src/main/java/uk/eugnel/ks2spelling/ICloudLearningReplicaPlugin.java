package uk.eugnel.ks2spelling;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONObject;

@CapacitorPlugin(name = "ICloudLearningReplica")
public final class ICloudLearningReplicaPlugin extends Plugin {
    private static final String CONTAINER = "iCloud.uk.eugnel.ks2spelling";

    @PluginMethod
    public void getStatus(PluginCall call) {
        if (!exactKeys(call.getData(), Collections.emptySet())) {
            reject(call);
            return;
        }
        JSObject result = new JSObject();
        result.put("available", false);
        result.put("account", "unsupported");
        result.put("container", CONTAINER);
        call.resolve(result);
    }

    @PluginMethod
    public void publish(PluginCall call) {
        Set<String> expected = new HashSet<String>();
        expected.add("profiles");
        expected.add("snapshots");
        if (!exactKeys(call.getData(), expected)) {
            reject(call);
            return;
        }
        JSObject result = new JSObject();
        result.put("accepted", 0);
        call.resolve(result);
    }

    @PluginMethod
    public void pull(PluginCall call) {
        if (!exactKeys(call.getData(), Collections.emptySet())) {
            reject(call);
            return;
        }
        JSObject result = new JSObject();
        result.put("profiles", new JSArray());
        result.put("snapshots", new JSArray());
        call.resolve(result);
    }

    private static boolean exactKeys(JSONObject value, Set<String> expected) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) actual.add(keys.next());
        return actual.equals(expected) && value.length() == expected.size();
    }

    private static void reject(PluginCall call) {
        call.reject(
            "The learning replica is unavailable.",
            "ICLOUD_REPLICA_UNAVAILABLE"
        );
    }
}
