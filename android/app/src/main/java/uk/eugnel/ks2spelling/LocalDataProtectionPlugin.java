package uk.eugnel.ks2spelling;

import android.content.pm.ApplicationInfo;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONObject;

@CapacitorPlugin(name = "LocalDataProtection")
public final class LocalDataProtectionPlugin extends Plugin {
    @PluginMethod
    public void applyDatabasePolicy(PluginCall call) {
        if (
            !exactKeys(call.getData(), Collections.singleton("databaseName"))
                || !"ks2-spelling".equals(call.getString("databaseName"))
        ) {
            reject(call, null);
            return;
        }
        try {
            ApplicationInfo application = getContext().getApplicationInfo();
            if ((application.flags & ApplicationInfo.FLAG_ALLOW_BACKUP) != 0) {
                throw new IOException("Automatic backup remains enabled.");
            }
            File dataRoot = new File(application.dataDir).getCanonicalFile();
            File databaseFile = getContext().getDatabasePath(
                "ks2-spellingSQLite.db"
            );
            File directory = databaseFile.getParentFile();
            if (directory == null) {
                throw new IOException("Database directory is unavailable.");
            }
            directory = directory.getCanonicalFile();
            String prefix = dataRoot.getPath() + File.separator;
            if (!directory.getPath().startsWith(prefix)) {
                throw new IOException("Database directory is not app-private.");
            }
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IOException("Database directory cannot be created.");
            }
            StructStat attributes = Os.stat(directory.getPath());
            int sharedPermissions =
                OsConstants.S_IRWXG | OsConstants.S_IRWXO;
            if (
                !directory.isDirectory()
                    || !directory.canRead()
                    || !directory.canWrite()
                    || (attributes.st_mode & sharedPermissions) != 0
            ) {
                throw new IOException("Database directory is not private.");
            }
            JSObject result = new JSObject();
            result.put("automaticBackupDisabled", true);
            result.put("platformProtection", "android-app-private");
            call.resolve(result);
        } catch (IOException | ErrnoException | RuntimeException error) {
            reject(call, error);
        }
    }

    private static boolean exactKeys(JSONObject value, Set<String> expected) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) actual.add(keys.next());
        return actual.equals(expected) && value.length() == expected.size();
    }

    private static void reject(PluginCall call, Exception error) {
        call.reject(
            "Local data protection could not be verified.",
            "LOCAL_DATA_PROTECTION_REJECTED",
            error
        );
    }
}
