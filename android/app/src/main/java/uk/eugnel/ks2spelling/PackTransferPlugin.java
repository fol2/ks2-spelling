package uk.eugnel.ks2spelling;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "PackTransfer")
public final class PackTransferPlugin extends Plugin {
    private static final int MAX_RANGE_BYTES = 1_048_576;
    private static final String PACK_ENVIRONMENT =
        BuildConfig.B3_SANDBOX_PROOF ? "sandbox" : "production";
    private static final Pattern SAFE_ID = Pattern.compile("^[a-z0-9][a-z0-9._-]{0,63}$");
    private static final Pattern ARCHIVE_NAME = Pattern.compile("^[a-z0-9][a-z0-9._-]{0,119}\\.zip$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern CAPABILITY_QUERY = Pattern.compile("^expires=([1-9][0-9]*)&cap=([A-Za-z0-9_-]{43})$");
    private static final Pattern CONTENT_RANGE = Pattern.compile("^bytes ([0-9]+)-([0-9]+)/([1-9][0-9]*)$");
    private static final String GATEWAY_ORIGIN = "https://b3-gateway.eugnel.uk";
    private static final String SIGNING_DOMAIN = "ks2-spelling-pack-manifest-v1";
    private static final String FREE_STARTER_PACK_ID = "ks2-core";
    private static final Set<String> ALLOWED_EXTENSIONS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(".json", ".m4a"))
    );
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @PluginMethod public void getFreeBytes(PluginCall call) {
        execute(call, Collections.emptySet(), () -> {
            File root = packRoot();
            long free = root.getUsableSpace();
            require(free >= 0 && free <= 9_007_199_254_740_991L);
            JSObject result = new JSObject();
            result.put("freeBytes", free);
            call.resolve(result);
        });
    }

    @PluginMethod public void downloadRange(PluginCall call) {
        execute(call, setOf("capabilityUrl", "packId", "version", "archiveName", "startByte", "endByteExclusive", "truncate"), () -> {
            String capability = requiredString(call, "capabilityUrl", 8192);
            String packId = requiredString(call, "packId", 64);
            String version = requiredString(call, "version", 64);
            String archiveName = requiredString(call, "archiveName", 128);
            Integer startValue = call.getInt("startByte");
            Integer endValue = call.getInt("endByteExclusive");
            Boolean truncateValue = call.getBoolean("truncate");
            require(startValue != null && endValue != null && truncateValue != null);
            int start = startValue;
            int endExclusive = endValue;
            boolean truncate = truncateValue;
            requireValidRange(start, endExclusive);
            require(!truncate || start == 0);

            URL authorised = validateCapability(capability, packId, version, archiveName);
            File partial = partialArchive(packId, version, archiveName);
            ensureOwnedDirectory(partial.getParentFile());
            long currentBytes = existingRegularBytes(partial);
            require(truncate || currentBytes >= start);

            HttpURLConnection connection = openValidatedCapability(
                capability, packId, version, archiveName,
                url -> (HttpURLConnection) url.openConnection()
            );
            configureConnection(connection, start, endExclusive);
            int status;
            byte[] body;
            String etag;
            String contentRange;
            try {
                status = connection.getResponseCode();
                require(connection.getURL().toString().equals(authorised.toString()));
                require(status < 300 || status >= 400);
                long announced = connection.getContentLengthLong();
                require(announced <= MAX_RANGE_BYTES);
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                body = readBounded(stream, MAX_RANGE_BYTES);
                etag = connection.getHeaderField("ETag");
                contentRange = connection.getHeaderField("Content-Range");
            } finally {
                connection.disconnect();
            }
            String safeError = safeDownloadErrorCode(status, body.length);
            if (safeError != null) throw new PackTransferException(safeError);

            require(etag != null && !etag.isEmpty() && etag.getBytes(StandardCharsets.UTF_8).length <= 256);
            int resultStart;
            int resultEnd;
            int total;
            if (status == 200) {
                require(body.length > 0 && body.length <= MAX_RANGE_BYTES);
                resultStart = 0;
                resultEnd = body.length;
                total = body.length;
            } else {
                require(status == 206);
                Matcher match = CONTENT_RANGE.matcher(nullToEmpty(contentRange));
                require(match.matches());
                resultStart = parseSafeInt(match.group(1));
                int inclusiveEnd = parseSafeInt(match.group(2));
                total = parseSafeInt(match.group(3));
                resultEnd = Math.addExact(inclusiveEnd, 1);
                require(resultStart == start && inclusiveEnd >= resultStart && inclusiveEnd < total);
                require(resultEnd == Math.min(endExclusive, total));
                require(body.length == resultEnd - resultStart && body.length > 0);
            }
            writeRange(partial, body, resultStart, truncate || status == 200);
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("startByte", resultStart);
            result.put("endByteExclusive", resultEnd);
            result.put("totalBytes", total);
            result.put("bytesWritten", body.length);
            result.put("etag", etag);
            call.resolve(result);
        });
    }

    @PluginMethod public void inspectAndExtract(PluginCall call) {
        execute(call, setOf("packId", "version", "archiveName", "signedManifestEnvelopeBase64"), () -> {
            String packId = requiredString(call, "packId", 64);
            String version = requiredString(call, "version", 64);
            String archiveName = requiredString(call, "archiveName", 128);
            String envelopeBase64 = requiredString(call, "signedManifestEnvelopeBase64", 1_048_576);
            validateIdentifier(packId);
            validateIdentifier(version);
            validateArchiveName(archiveName);
            byte[] envelopeBytes = decodeCanonicalBase64(envelopeBase64, 1_048_576);
            VerifiedManifest verified = verifySignedManifest(envelopeBytes);
            require(verified.packId.equals(packId) && verified.version.equals(version));
            require(verified.archiveName.equals(archiveName));

            File archive = partialArchive(packId, version, archiveName);
            ZipCentralDirectoryInspector.validateManifestCeilings(verified.inventory);
            byte[] archiveBytes = readRegularFile(archive, verified.archiveBytes);
            require(archiveBytes.length == verified.archiveBytes);
            require(sha256(archiveBytes).equals(verified.archiveSha256));
            ZipCentralDirectoryInspector.Inventory inventory = ZipCentralDirectoryInspector.inspect(
                archiveBytes, verified.inventory
            );
            File versionRoot = archive.getParentFile();
            File extractionRoot = new File(versionRoot, "extracted");
            if (pathExists(extractionRoot)) deleteOwnedTree(extractionRoot);
            ensureOwnedDirectory(extractionRoot);

            int extractedTotal = ZipCentralDirectoryInspector.consumeVerifiedEntries(
                archiveBytes, inventory, verified.inventory.extractedBytesCeiling,
                (approved, content) -> {
                    File destination = containedChild(extractionRoot, approved.path);
                    ensureOwnedDirectory(destination.getParentFile());
                    writeApproved(destination, content);
                }
            );
            String manifestSha = sha256(envelopeBytes);
            byte[] inspection = inspectionMarker(manifestSha, verified.archiveSha256, extractedTotal, inventory.entries.size());
            writeNewRegularFile(new File(versionRoot, "inspection.json"), inspection);
            fsyncDirectory(versionRoot);
            JSObject result = new JSObject();
            result.put("archiveSha256", verified.archiveSha256);
            result.put("manifestSha256", manifestSha);
            result.put("extractedBytes", extractedTotal);
            result.put("fileCount", inventory.entries.size());
            result.put("stagingToken", "staging/" + packId + "/" + version);
            call.resolve(result);
        });
    }

    @PluginMethod public void sealAndInstall(PluginCall call) {
        execute(call, setOf("packId", "version", "manifestSha256"), () -> {
            String packId = requiredString(call, "packId", 64);
            String version = requiredString(call, "version", 64);
            String manifestSha = requiredString(call, "manifestSha256", 64);
            validateIdentifier(packId);
            validateIdentifier(version);
            require(SHA256.matcher(manifestSha).matches());
            File staging = stagingVersion(packId, version);
            File installed = installedVersion(packId, version);
            ensureOwnedDirectory(installed.getParentFile());
            byte[] marker = activationMarker(manifestSha, packId, version);
            String markerSha = sha256(marker);
            if (pathExists(installed)) {
                requireDirectory(installed);
                require(Arrays.equals(readRegularFile(new File(installed, "activation.json"), 16_384), marker));
            } else {
                requireDirectory(staging);
                JSONObject inspection = closedJson(readRegularFile(new File(staging, "inspection.json"), 16_384),
                    setOf("archiveSha256", "extractedBytes", "fileCount", "manifestSha256"));
                require(manifestSha.equals(inspection.getString("manifestSha256")));
                requireDirectory(new File(staging, "extracted"));
                File markerFile = new File(staging, "activation.json");
                if (pathExists(markerFile)) require(Arrays.equals(readRegularFile(markerFile, 16_384), marker));
                else writeNewRegularFile(markerFile, marker);
                fsyncDirectory(staging);
                try { Os.rename(staging.getAbsolutePath(), installed.getAbsolutePath()); }
                catch (ErrnoException error) { throw rejected(error); }
                fsyncDirectory(installed.getParentFile());
            }
            JSObject result = new JSObject();
            result.put("installedPathToken", "installed/" + packId + "/" + version);
            result.put("activationMarkerSha256", markerSha);
            call.resolve(result);
        });
    }

    @PluginMethod public void inventoryInstalledVersions(PluginCall call) {
        execute(call, Collections.emptySet(), () -> {
            File installedRoot = new File(packRoot(), "installed");
            ensureOwnedDirectory(installedRoot);
            List<JSObject> versions = new ArrayList<>();
            for (File pack : safeDirectoryChildren(installedRoot)) {
                validateIdentifier(pack.getName());
                for (File version : safeDirectoryChildren(pack)) {
                    validateIdentifier(version.getName());
                    byte[] markerBytes = readRegularFile(new File(version, "activation.json"), 16_384);
                    JSONObject marker = closedJson(markerBytes, setOf("manifestSha256", "packId", "version"));
                    require(marker.getString("packId").equals(pack.getName()));
                    require(marker.getString("version").equals(version.getName()));
                    String manifestSha = marker.getString("manifestSha256");
                    require(SHA256.matcher(manifestSha).matches());
                    require(Arrays.equals(markerBytes, activationMarker(manifestSha, pack.getName(), version.getName())));
                    JSObject item = new JSObject();
                    item.put("packId", pack.getName());
                    item.put("version", version.getName());
                    item.put("installedPathToken", "installed/" + pack.getName() + "/" + version.getName());
                    item.put("manifestSha256", manifestSha);
                    item.put("activationMarkerSha256", sha256(markerBytes));
                    versions.add(item);
                }
            }
            versions.sort(Comparator.comparing((JSObject value) -> value.getString("packId"))
                .thenComparing(value -> value.getString("version")));
            JSArray array = new JSArray();
            for (JSObject value : versions) array.put(value);
            JSObject result = new JSObject();
            result.put("versions", array);
            call.resolve(result);
        });
    }

    @PluginMethod public void removeOwnedTemporaryState(PluginCall call) {
        execute(call, setOf("packId", "version"), () -> {
            String packId = requiredString(call, "packId", 64);
            String version = requiredString(call, "version", 64);
            File staging = stagingVersion(packId, version);
            boolean existed = pathExists(staging);
            if (existed) deleteOwnedTree(staging);
            JSObject result = new JSObject();
            result.put("removed", existed);
            call.resolve(result);
        });
    }

    @Override protected void handleOnDestroy() {
        worker.shutdownNow();
        super.handleOnDestroy();
    }

    private void execute(PluginCall call, Set<String> keys, ThrowingOperation operation) {
        if (!exactKeys(call.getData(), keys)) {
            call.reject("Pack transfer rejected.", "PACK_TRANSFER_REJECTED");
            return;
        }
        worker.execute(() -> {
            try { operation.run(); }
            catch (PackTransferException error) { call.reject("Pack transfer rejected.", error.safeCode); }
            catch (Exception error) { call.reject("Pack transfer rejected.", "PACK_TRANSFER_REJECTED"); }
        });
    }

    static URL validateCapability(String value, String packId, String version, String archiveName) throws Exception {
        validateIdentifier(packId);
        validateIdentifier(version);
        validateArchiveName(archiveName);
        require(value.getBytes(StandardCharsets.UTF_8).length <= 8192);
        URI uri = new URI(value);
        require("https".equals(uri.getScheme()) && "b3-gateway.eugnel.uk".equals(uri.getHost()));
        require(uri.getRawUserInfo() == null && uri.getPort() == -1 && uri.getRawFragment() == null);
        String path = "/v1/packs/" + packId + "/" + version + "/" + archiveName;
        require(path.equals(uri.getRawPath()));
        Matcher query = CAPABILITY_QUERY.matcher(nullToEmpty(uri.getRawQuery()));
        require(query.matches());
        long expires = Long.parseLong(query.group(1));
        require(expires > 0);
        require(uri.toASCIIString().equals(value));
        require(value.equals(GATEWAY_ORIGIN + path + "?" + uri.getRawQuery()));
        return uri.toURL();
    }

    static HttpURLConnection openValidatedCapability(String value, String packId, String version,
        String archiveName, ConnectionFactory factory) throws Exception {
        URL authorised = validateCapability(value, packId, version, archiveName);
        return factory.open(authorised);
    }

    static void configureConnection(HttpURLConnection connection, int start, int endExclusive)
        throws Exception {
        requireValidRange(start, endExclusive);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(30_000);
        connection.setReadTimeout(30_000);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Origin", "http://localhost");
        connection.setRequestProperty("Range", "bytes=" + start + "-" + (endExclusive - 1));
        connection.setRequestProperty("Accept-Encoding", "identity");
    }

    private static void requireValidRange(int start, int endExclusive) throws Exception {
        require(start >= 0 && endExclusive > start);
        require((long) endExclusive - (long) start <= MAX_RANGE_BYTES);
    }

    static String safeDownloadErrorCode(int status, int bodyLength) {
        if (status == 400) return "PACK_CAPABILITY_EXPIRED";
        if (status == 416 && bodyLength == 0) return "PACK_RANGE_NOT_SATISFIABLE";
        return null;
    }

    private VerifiedManifest verifySignedManifest(byte[] envelopeBytes) throws Exception {
        JSONObject envelope = closedJson(envelopeBytes, setOf(
            "schemaVersion", "algorithm", "keyId", "payloadEncoding", "domain",
            "canonicalManifestBase64", "signatureDerBase64"
        ));
        require(envelope.getInt("schemaVersion") == 1);
        require("ECDSA_P256_SHA256_DER".equals(envelope.getString("algorithm")));
        require("RFC8785_UTF8".equals(envelope.getString("payloadEncoding")));
        require(SIGNING_DOMAIN.equals(envelope.getString("domain")));
        byte[] canonical = decodeCanonicalBase64(envelope.getString("canonicalManifestBase64"), 1_048_576);
        byte[] signatureDer = decodeCanonicalBase64(envelope.getString("signatureDerBase64"), 256);
        requireCanonicalEcdsaDer(signatureDer);

        JSONObject keyring = closedJson(readAsset("pack-signing-public-keys.json", 65_536), setOf("schemaVersion", "keys"));
        require(keyring.getInt("schemaVersion") == 1);
        JSONArray keys = keyring.getJSONArray("keys");
        JSONObject selected = null;
        for (int index = 0; index < keys.length(); index += 1) {
            JSONObject key = keys.getJSONObject(index);
            if (envelope.getString("keyId").equals(key.getString("keyId"))) {
                require(selected == null);
                selected = key;
            }
        }
        require(selected != null);
        require(exactKeys(selected, setOf("keyId", "algorithm", "publicKeySpkiDerBase64", "publicKeySpkiSha256", "testOnly", "notBefore", "notAfter", "allowedEnvironments", "allowedPackIds")));
        require(selected.getBoolean("testOnly") == "sandbox".equals(PACK_ENVIRONMENT));
        List<String> allowedEnvironments =
            arrayStrings(selected.getJSONArray("allowedEnvironments"));
        require(allowedEnvironments.contains(PACK_ENVIRONMENT));
        require(selected.getString("algorithm").equals(envelope.getString("algorithm")));
        Date now = new Date();
        require(!now.before(parseIso8601(selected.getString("notBefore"))));
        require(!now.after(parseIso8601(selected.getString("notAfter"))));
        byte[] spki = decodeCanonicalBase64(selected.getString("publicKeySpkiDerBase64"), 1024);
        require(sha256(spki).equals(selected.getString("publicKeySpkiSha256")));
        PublicKey publicKey = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spki));
        require(publicKey instanceof ECPublicKey);
        ECPublicKey ec = (ECPublicKey) publicKey;
        require(ec.getParams().getCurve().getField().getFieldSize() == 256);
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(publicKey);
        verifier.update(SIGNING_DOMAIN.getBytes(StandardCharsets.UTF_8));
        verifier.update((byte) 0);
        verifier.update(canonical);
        require(verifier.verify(signatureDer));

        JSONObject manifest = new JSONObject(new String(canonical, StandardCharsets.UTF_8));
        require(Arrays.equals(canonical, canonicalJson(manifest).getBytes(StandardCharsets.UTF_8)));
        require(exactKeys(manifest, setOf("allowedExtensions", "archive", "ceilings", "files", "packId", "requiredEntitlementId", "schemaVersion", "version")));
        require(manifest.getInt("schemaVersion") == 1);
        String packId = manifest.getString("packId");
        require(arrayStrings(selected.getJSONArray("allowedPackIds")).contains(packId));
        Object requiredEntitlementId = manifest.get("requiredEntitlementId");
        require(requiredEntitlementId == JSONObject.NULL
            ? FREE_STARTER_PACK_ID.equals(packId)
            : "full-ks2".equals(requiredEntitlementId));
        List<String> extensions = arrayStrings(manifest.getJSONArray("allowedExtensions"));
        require(new HashSet<>(extensions).equals(ALLOWED_EXTENSIONS) && extensions.size() == 2);
        JSONObject archive = manifest.getJSONObject("archive");
        require(exactKeys(archive, setOf("bytes", "name", "sha256")));
        require(archive.getInt("bytes") > 0);
        require(ARCHIVE_NAME.matcher(archive.getString("name")).matches());
        require(SHA256.matcher(archive.getString("sha256")).matches());
        JSONObject ceilings = manifest.getJSONObject("ceilings");
        require(exactKeys(ceilings, setOf("compressedBytes", "extractedBytes", "fileCount")));
        JSONArray files = manifest.getJSONArray("files");
        List<ZipCentralDirectoryInspector.FileDeclaration> declarations = new ArrayList<>();
        for (int index = 0; index < files.length(); index += 1) {
            JSONObject file = files.getJSONObject(index);
            require(exactKeys(file, setOf("bytes", "path", "sha256")));
            declarations.add(new ZipCentralDirectoryInspector.FileDeclaration(
                file.getString("path"), file.getInt("bytes"), file.getString("sha256")
            ));
        }
        ZipCentralDirectoryInspector.ManifestInventory inventory =
            new ZipCentralDirectoryInspector.ManifestInventory(
                1, archive.getInt("bytes"), ceilings.getInt("fileCount"),
                ceilings.getInt("compressedBytes"), ceilings.getInt("extractedBytes"),
                extensions, declarations
            );
        return new VerifiedManifest(
            packId, manifest.getString("version"), archive.getString("name"),
            archive.getInt("bytes"), archive.getString("sha256"), inventory
        );
    }

    private void writeApproved(File destination, byte[] content) throws Exception {
        FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(destination.getAbsolutePath(),
                OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW,
                0600);
            StructStat stat = Os.fstat(descriptor);
            require((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFREG);
            writeAll(descriptor, content, content.length);
            Os.fsync(descriptor);
        } catch (ErrnoException error) {
            throw rejected(error);
        } finally {
            if (descriptor != null) try { Os.close(descriptor); } catch (ErrnoException ignored) {}
        }
    }

    private void writeRange(File file, byte[] bytes, int start, boolean truncate) throws Exception {
        if (truncate && pathExists(file)) deleteRegular(file);
        FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(file.getAbsolutePath(),
                OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_NOFOLLOW, 0600);
            StructStat stat = Os.fstat(descriptor);
            require((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFREG);
            require(truncate || stat.st_size >= start);
            Os.ftruncate(descriptor, start);
            Os.lseek(descriptor, start, OsConstants.SEEK_SET);
            writeAll(descriptor, bytes, bytes.length);
            Os.fsync(descriptor);
        } catch (ErrnoException error) { throw rejected(error); }
        finally { if (descriptor != null) try { Os.close(descriptor); } catch (ErrnoException ignored) {} }
    }

    private static void writeAll(FileDescriptor descriptor, byte[] bytes, int length) throws ErrnoException, IOException, PackTransferException {
        int offset = 0;
        while (offset < length) {
            int count = Os.write(descriptor, bytes, offset, length - offset);
            require(count > 0);
            offset += count;
        }
    }

    private File packRoot() throws Exception {
        File root = new File(getContext().getFilesDir(), "ks2-spelling/packs");
        secureDirectoryChain(getContext().getFilesDir(), root);
        return root;
    }

    private File stagingVersion(String packId, String version) throws Exception {
        validateIdentifier(packId); validateIdentifier(version);
        return containedChild(new File(packRoot(), "staging"), packId + "/" + version);
    }

    private File installedVersion(String packId, String version) throws Exception {
        validateIdentifier(packId); validateIdentifier(version);
        return containedChild(new File(packRoot(), "installed"), packId + "/" + version);
    }

    private File partialArchive(String packId, String version, String archiveName) throws Exception {
        validateArchiveName(archiveName);
        return containedChild(stagingVersion(packId, version), archiveName + ".partial");
    }

    private void ensureOwnedDirectory(File directory) throws Exception {
        File root = packRoot();
        requireContained(root, directory);
        secureDirectoryChain(root, directory);
    }

    private static void secureDirectoryChain(File base, File target) throws Exception {
        String basePath = base.getAbsoluteFile().getPath();
        String targetPath = target.getAbsoluteFile().getPath();
        require(targetPath.equals(basePath) || targetPath.startsWith(basePath + File.separator));
        if (!pathExists(base)) {
            File parent = base.getParentFile();
            require(parent != null && parent.isDirectory());
            require(base.mkdir());
        }
        requireDirectory(base);
        String suffix = targetPath.substring(basePath.length());
        File current = base;
        for (String component : suffix.split(Pattern.quote(File.separator))) {
            if (component.isEmpty()) continue;
            current = new File(current, component);
            if (!pathExists(current)) require(current.mkdir());
            requireDirectory(current);
        }
    }

    private static File containedChild(File root, String relative) throws Exception {
        require(!relative.startsWith(File.separator) && !relative.contains("\\"));
        for (String component : relative.split("/", -1)) {
            require(!component.isEmpty() && !component.equals(".") && !component.equals(".."));
        }
        File child = new File(root, relative);
        requireContained(root, child);
        return child;
    }

    private static void requireContained(File root, File child) throws Exception {
        String rootPath = root.getAbsoluteFile().getPath();
        String childPath = child.getAbsoluteFile().getPath();
        require(childPath.equals(rootPath) || childPath.startsWith(rootPath + File.separator));
    }

    private static boolean pathExists(File file) throws Exception {
        try { Os.lstat(file.getAbsolutePath()); return true; }
        catch (ErrnoException error) {
            if (error.errno == OsConstants.ENOENT) return false;
            throw rejected(error);
        }
    }

    private static void requireDirectory(File file) throws Exception {
        StructStat stat;
        try { stat = Os.lstat(file.getAbsolutePath()); } catch (ErrnoException error) { throw rejected(error); }
        require((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFDIR);
    }

    private static long existingRegularBytes(File file) throws Exception {
        if (!pathExists(file)) return 0;
        StructStat stat;
        try { stat = Os.lstat(file.getAbsolutePath()); } catch (ErrnoException error) { throw rejected(error); }
        require((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFREG && stat.st_size >= 0);
        return stat.st_size;
    }

    private static void deleteRegular(File file) throws Exception {
        require(existingRegularBytes(file) >= 0);
        try { Os.remove(file.getAbsolutePath()); } catch (ErrnoException error) { throw rejected(error); }
    }

    private static void deleteOwnedTree(File root) throws Exception {
        StructStat stat;
        try { stat = Os.lstat(root.getAbsolutePath()); } catch (ErrnoException error) { throw rejected(error); }
        if ((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFDIR) {
            File[] children = root.listFiles();
            require(children != null);
            for (File child : children) deleteOwnedTree(child);
            try { Os.remove(root.getAbsolutePath()); } catch (ErrnoException error) { throw rejected(error); }
        } else if ((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFREG) {
            try { Os.remove(root.getAbsolutePath()); } catch (ErrnoException error) { throw rejected(error); }
        } else throw rejected(null);
    }

    private static List<File> safeDirectoryChildren(File directory) throws Exception {
        requireDirectory(directory);
        File[] children = directory.listFiles();
        require(children != null);
        List<File> result = new ArrayList<>(Arrays.asList(children));
        for (File child : result) requireDirectory(child);
        result.sort(Comparator.comparing(File::getName));
        return result;
    }

    private static void writeNewRegularFile(File file, byte[] bytes) throws Exception {
        if (pathExists(file)) deleteRegular(file);
        FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(file.getAbsolutePath(),
                OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW, 0600);
            writeAll(descriptor, bytes, bytes.length);
            Os.fsync(descriptor);
        } catch (ErrnoException error) { throw rejected(error); }
        finally { if (descriptor != null) try { Os.close(descriptor); } catch (ErrnoException ignored) {} }
    }

    private static void fsyncDirectory(File directory) throws Exception {
        FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0);
            StructStat stat = Os.fstat(descriptor);
            require((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFDIR);
            Os.fsync(descriptor);
        } catch (ErrnoException error) {
            if (error.errno != OsConstants.EINVAL && error.errno != OsConstants.ENOTSUP) throw rejected(error);
        } finally { if (descriptor != null) try { Os.close(descriptor); } catch (ErrnoException ignored) {} }
    }

    private byte[] readAsset(String name, int maximum) throws Exception {
        try (InputStream input = getContext().getAssets().open(name)) { return readBounded(input, maximum); }
    }

    private static byte[] readRegularFile(File file, int maximum) throws Exception {
        FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(file.getAbsolutePath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0);
            StructStat stat = Os.fstat(descriptor);
            require((stat.st_mode & OsConstants.S_IFMT) == OsConstants.S_IFREG);
            require(stat.st_size >= 0 && stat.st_size <= maximum && stat.st_size <= Integer.MAX_VALUE);
            byte[] result = new byte[(int) stat.st_size];
            int offset = 0;
            while (offset < result.length) {
                int count = Os.read(descriptor, result, offset, result.length - offset);
                require(count > 0);
                offset += count;
            }
            byte[] sentinel = new byte[1];
            require(Os.read(descriptor, sentinel, 0, 1) == 0);
            return result;
        } catch (ErrnoException error) {
            throw rejected(error);
        } finally {
            if (descriptor != null) try { Os.close(descriptor); } catch (ErrnoException ignored) {}
        }
    }

    private static byte[] readBounded(InputStream input, int maximum) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[64 * 1024];
            int total = 0;
            while (true) {
                int count = stream.read(buffer);
                if (count == -1) break;
                require(count > 0);
                total = Math.addExact(total, count);
                require(total <= maximum);
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private static JSONObject closedJson(byte[] bytes, Set<String> keys) throws Exception {
        JSONObject value = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        require(exactKeys(value, keys));
        return value;
    }

    private static boolean exactKeys(JSONObject value, Set<String> expected) {
        Set<String> actual = new HashSet<>();
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) actual.add(keys.next());
        return actual.equals(expected) && value.length() == expected.size();
    }

    private static List<String> arrayStrings(JSONArray array) throws Exception {
        List<String> result = new ArrayList<>();
        for (int index = 0; index < array.length(); index += 1) result.add(array.getString(index));
        return result;
    }

    private static String canonicalJson(Object value) throws Exception {
        if (value == JSONObject.NULL) return "null";
        if (value instanceof Boolean) return value.toString();
        if (value instanceof String) return JSONObject.quote((String) value);
        if (value instanceof Number) {
            require(value instanceof Integer || value instanceof Long);
            return value.toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder result = new StringBuilder("[");
            for (int index = 0; index < array.length(); index += 1) {
                if (index > 0) result.append(',');
                result.append(canonicalJson(array.get(index)));
            }
            return result.append(']').toString();
        }
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> keys = new ArrayList<>();
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            Collections.sort(keys);
            StringBuilder result = new StringBuilder("{");
            for (int index = 0; index < keys.size(); index += 1) {
                if (index > 0) result.append(',');
                String key = keys.get(index);
                result.append(JSONObject.quote(key)).append(':').append(canonicalJson(object.get(key)));
            }
            return result.append('}').toString();
        }
        throw rejected(null);
    }

    private static void requireCanonicalEcdsaDer(byte[] value) throws Exception {
        require(value.length >= 8 && value.length <= 72 && (value[0] & 0xff) == 0x30);
        require((value[1] & 0xff) == value.length - 2);
        int cursor = 2;
        for (int index = 0; index < 2; index += 1) {
            require(cursor + 2 <= value.length && (value[cursor] & 0xff) == 0x02);
            int length = value[cursor + 1] & 0xff;
            require(length >= 1 && length <= 33 && cursor + 2 + length <= value.length);
            int first = value[cursor + 2] & 0xff;
            require((first & 0x80) == 0);
            require(!(length > 1 && first == 0 && ((value[cursor + 3] & 0x80) == 0)));
            cursor += 2 + length;
        }
        require(cursor == value.length);
    }

    private static byte[] decodeCanonicalBase64(String value, int maximum) throws Exception {
        require(value.matches("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"));
        byte[] bytes = Base64.decode(value, Base64.NO_WRAP);
        require(bytes.length <= maximum && Base64.encodeToString(bytes, Base64.NO_WRAP).equals(value));
        return bytes;
    }

    private static Date parseIso8601(String value) throws Exception {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setLenient(false);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        ParsePosition position = new ParsePosition(0);
        Date date = format.parse(value, position);
        require(date != null && position.getIndex() == value.length());
        return date;
    }

    private static byte[] inspectionMarker(String manifestSha, String archiveSha, int extracted, int count) {
        return ("{\"archiveSha256\":" + JSONObject.quote(archiveSha)
            + ",\"extractedBytes\":" + extracted + ",\"fileCount\":" + count
            + ",\"manifestSha256\":" + JSONObject.quote(manifestSha) + "}\n")
            .getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] activationMarker(String manifestSha, String packId, String version) {
        return ("{\"manifestSha256\":" + JSONObject.quote(manifestSha)
            + ",\"packId\":" + JSONObject.quote(packId)
            + ",\"version\":" + JSONObject.quote(version) + "}\n")
            .getBytes(StandardCharsets.UTF_8);
    }

    private static String requiredString(PluginCall call, String key, int maximum) throws Exception {
        String value = call.getString(key);
        require(value != null && value.getBytes(StandardCharsets.UTF_8).length <= maximum);
        return value;
    }

    private static void validateIdentifier(String value) throws Exception { require(SAFE_ID.matcher(value).matches()); }
    private static void validateArchiveName(String value) throws Exception { require(ARCHIVE_NAME.matcher(value).matches()); }
    private static int parseSafeInt(String value) throws Exception {
        long parsed = Long.parseLong(value);
        require(parsed >= 0 && parsed <= Integer.MAX_VALUE);
        return (int) parsed;
    }
    private static String sha256(byte[] value) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(value)); }
    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte entry : value) result.append(String.format(Locale.ROOT, "%02x", entry & 0xff));
        return result.toString();
    }
    private static String nullToEmpty(String value) { return value == null ? "" : value; }
    private static Set<String> setOf(String... values) { return new HashSet<>(Arrays.asList(values)); }
    private static void require(boolean condition) throws PackTransferException { if (!condition) throw rejected(null); }
    private static PackTransferException rejected(Exception cause) { return new PackTransferException("PACK_TRANSFER_REJECTED", cause); }

    interface ConnectionFactory { HttpURLConnection open(URL url) throws Exception; }
    private interface ThrowingOperation { void run() throws Exception; }
    private static final class PackTransferException extends Exception {
        final String safeCode;
        PackTransferException(String safeCode) { this(safeCode, null); }
        PackTransferException(String safeCode, Exception cause) { super("Pack transfer rejected.", cause); this.safeCode = safeCode; }
    }
    private static final class VerifiedManifest {
        final String packId, version, archiveName, archiveSha256;
        final int archiveBytes;
        final ZipCentralDirectoryInspector.ManifestInventory inventory;
        VerifiedManifest(String packId, String version, String archiveName, int archiveBytes,
            String archiveSha256, ZipCentralDirectoryInspector.ManifestInventory inventory) {
            this.packId = packId; this.version = version; this.archiveName = archiveName;
            this.archiveBytes = archiveBytes; this.archiveSha256 = archiveSha256; this.inventory = inventory;
        }
    }
}
