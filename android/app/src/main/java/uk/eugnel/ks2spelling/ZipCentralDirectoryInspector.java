package uk.eugnel.ks2spelling;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Owns every ZIP metadata decision before platform extraction is allowed. */
public final class ZipCentralDirectoryInspector {
    static final int MAXIMUM_FILE_COUNT = 1_024;
    static final int MAXIMUM_COMPRESSED_BYTES = 32 * 1_024 * 1_024;
    static final int MAXIMUM_EXTRACTED_BYTES = 32 * 1_024 * 1_024;

    private static final long END_SIGNATURE = 0x06054b50L;
    private static final long CENTRAL_SIGNATURE = 0x02014b50L;
    private static final long LOCAL_SIGNATURE = 0x04034b50L;
    private static final int UTF8_FLAG = 0x0800;
    private static final int REGULAR_MODE = 0100644;
    private static final Set<String> ALLOWED_EXTENSIONS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList(".json", ".m4a"))
    );
    private static final Pattern SAFE_PATH = Pattern.compile(
        "^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$"
    );

    private ZipCentralDirectoryInspector() {}

    static void validateManifestCeilings(ManifestInventory manifest) throws IOException {
        require(manifest != null && manifest.schemaVersion == 1);
        require(manifest.archiveBytes > 0 && manifest.archiveBytes <= MAXIMUM_COMPRESSED_BYTES);
        require(manifest.fileCountCeiling > 0
            && manifest.fileCountCeiling <= MAXIMUM_FILE_COUNT);
        require(manifest.compressedBytesCeiling > 0
            && manifest.compressedBytesCeiling <= MAXIMUM_COMPRESSED_BYTES);
        require(manifest.extractedBytesCeiling > 0
            && manifest.extractedBytesCeiling <= MAXIMUM_EXTRACTED_BYTES);
        require(new HashSet<>(manifest.allowedExtensions).equals(ALLOWED_EXTENSIONS));
    }

    public static Inventory inspect(byte[] bytes, ManifestInventory manifest) throws IOException {
        validateManifestCeilings(manifest);
        require(bytes.length == manifest.archiveBytes
            && bytes.length <= manifest.compressedBytesCeiling && bytes.length >= 22);

        List<Integer> endOffsets = signatureOffsets(END_SIGNATURE, bytes);
        require(endOffsets.size() == 1);
        int endOffset = endOffsets.get(0);
        require(endOffset + 22 == bytes.length);
        require(read16(bytes, endOffset + 4) == 0 && read16(bytes, endOffset + 6) == 0);
        require(read16(bytes, endOffset + 8) == read16(bytes, endOffset + 10));
        require(read16(bytes, endOffset + 20) == 0);
        int entryCount = read16(bytes, endOffset + 10);
        long centralSizeLong = read32(bytes, endOffset + 12);
        long centralOffsetLong = read32(bytes, endOffset + 16);
        require(entryCount > 0 && entryCount <= manifest.fileCountCeiling);
        require(centralSizeLong <= Integer.MAX_VALUE && centralOffsetLong <= Integer.MAX_VALUE);
        int centralSize = (int) centralSizeLong;
        int centralOffset = (int) centralOffsetLong;
        require(checkedAdd(centralOffset, centralSize) == endOffset);

        Map<String, FileDeclaration> declared = declaredFiles(manifest);
        Set<String> seenPaths = new HashSet<>();
        Set<String> foldedPaths = new HashSet<>();
        Set<Integer> localOffsets = new HashSet<>();
        List<RangeRecord> localRanges = new ArrayList<>();
        List<RangeRecord> dataRanges = new ArrayList<>();
        List<Entry> entries = new ArrayList<>();
        int compressedTotal = 0;
        int extractedTotal = 0;
        int cursor = centralOffset;

        for (int index = 0; index < entryCount; index += 1) {
            require(checkedAdd(cursor, 46) <= endOffset && read32(bytes, cursor) == CENTRAL_SIGNATURE);
            int madeBy = read16(bytes, cursor + 4);
            int versionNeeded = read16(bytes, cursor + 6);
            int centralFlags = read16(bytes, cursor + 8);
            int method = read16(bytes, cursor + 10);
            long crc = read32(bytes, cursor + 16);
            long compressedLong = read32(bytes, cursor + 20);
            long extractedLong = read32(bytes, cursor + 24);
            int nameLength = read16(bytes, cursor + 28);
            int extraLength = read16(bytes, cursor + 30);
            int commentLength = read16(bytes, cursor + 32);
            int diskStart = read16(bytes, cursor + 34);
            int internalAttributes = read16(bytes, cursor + 36);
            long externalAttributes = read32(bytes, cursor + 38);
            long localOffsetLong = read32(bytes, cursor + 42);
            require(compressedLong != 0xffffffffL && extractedLong != 0xffffffffL);
            require(compressedLong <= Integer.MAX_VALUE && extractedLong <= Integer.MAX_VALUE);
            require(localOffsetLong <= Integer.MAX_VALUE);
            int compressed = (int) compressedLong;
            int extracted = (int) extractedLong;
            int localOffset = (int) localOffsetLong;
            int recordEnd = checkedAdd(cursor, checkedAdd(46, checkedAdd(nameLength, checkedAdd(extraLength, commentLength))));
            require((madeBy >>> 8) == 3 && versionNeeded <= 20);
            require(centralFlags == UTF8_FLAG && (method == 0 || method == 8));
            require(nameLength > 0 && extraLength == 0 && commentLength == 0);
            require(diskStart == 0 && internalAttributes == 0);
            require(((externalAttributes >>> 16) & 0xffffL) == REGULAR_MODE);
            require(recordEnd <= endOffset && localOffset < centralOffset && localOffsets.add(localOffset));
            byte[] centralNameBytes = slice(bytes, cursor + 46, checkedAdd(cursor + 46, nameLength));
            String path = strictAsciiUtf8(centralNameBytes);
            validatePath(path, manifest);
            String folded = Normalizer.normalize(path, Normalizer.Form.NFC).toLowerCase(Locale.ROOT);
            FileDeclaration declaration = declared.get(path);
            require(seenPaths.add(path) && foldedPaths.add(folded));
            require(declaration != null && declaration.bytes == extracted);

            require(checkedAdd(localOffset, 30) <= centralOffset && read32(bytes, localOffset) == LOCAL_SIGNATURE);
            int localNameLength = read16(bytes, localOffset + 26);
            int localExtraLength = read16(bytes, localOffset + 28);
            int dataStart = checkedAdd(localOffset, checkedAdd(30, checkedAdd(localNameLength, localExtraLength)));
            int dataEnd = checkedAdd(dataStart, compressed);
            require(read16(bytes, localOffset + 4) == versionNeeded);
            require(read16(bytes, localOffset + 6) == centralFlags);
            require(read16(bytes, localOffset + 8) == method);
            require(read16(bytes, localOffset + 10) == read16(bytes, cursor + 12));
            require(read16(bytes, localOffset + 12) == read16(bytes, cursor + 14));
            require(read32(bytes, localOffset + 14) == crc);
            require(read32(bytes, localOffset + 18) == compressedLong);
            require(read32(bytes, localOffset + 22) == extractedLong);
            require(localNameLength == nameLength && localExtraLength == 0 && dataEnd <= centralOffset);
            require(java.util.Arrays.equals(
                slice(bytes, localOffset + 30, checkedAdd(localOffset + 30, localNameLength)),
                centralNameBytes
            ));
            localRanges.add(new RangeRecord(localOffset, dataEnd));
            dataRanges.add(new RangeRecord(dataStart, dataEnd));
            compressedTotal = checkedAdd(compressedTotal, compressed);
            extractedTotal = checkedAdd(extractedTotal, extracted);
            entries.add(new Entry(path, method, crc, compressed, extracted, declaration.sha256));
            cursor = recordEnd;
        }

        require(cursor == endOffset && entries.size() == declared.size());
        require(compressedTotal <= manifest.compressedBytesCeiling);
        require(extractedTotal <= manifest.extractedBytesCeiling);
        requireTiledLocalRecords(localRanges, centralOffset);
        requireNoOverlap(dataRanges);
        return new Inventory(entries, compressedTotal, extractedTotal);
    }

    /** Consumes only the byte array already approved by {@link #inspect(byte[], ManifestInventory)}. */
    public static int consumeVerifiedEntries(byte[] archiveBytes, Inventory inventory,
        int extractedBytesCeiling, VerifiedEntryConsumer consumer) throws Exception {
        require(archiveBytes != null && inventory != null && consumer != null);
        require(extractedBytesCeiling > 0
            && extractedBytesCeiling <= MAXIMUM_EXTRACTED_BYTES);
        int extractedTotal = 0;
        try (ZipInputStream input = new ZipInputStream(new ByteArrayInputStream(archiveBytes))) {
            for (Entry approved : inventory.entries) {
                ZipEntry platform = input.getNextEntry();
                require(platform != null && !platform.isDirectory());
                require(approved.path.equals(platform.getName()));
                require(platform.getMethod() == approved.method);
                require(platform.getCrc() == approved.crc32);
                require(platform.getSize() == approved.extractedBytes);
                require(platform.getCompressedSize() == approved.compressedBytes);

                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                CRC32 crc = new CRC32();
                ByteArrayOutputStream content = new ByteArrayOutputStream(
                    Math.min(approved.extractedBytes, 64 * 1024)
                );
                byte[] buffer = new byte[64 * 1024];
                int written = 0;
                while (true) {
                    int count = input.read(buffer);
                    if (count == -1) break;
                    require(count > 0);
                    written = checkedAdd(written, count);
                    require(written <= approved.extractedBytes);
                    digest.update(buffer, 0, count);
                    crc.update(buffer, 0, count);
                    content.write(buffer, 0, count);
                }
                input.closeEntry();
                require(written == approved.extractedBytes);
                require(crc.getValue() == approved.crc32);
                require(hex(digest.digest()).equals(approved.sha256));
                require(platform.getCrc() == approved.crc32);
                require(platform.getSize() == approved.extractedBytes);
                require(platform.getCompressedSize() == approved.compressedBytes);
                extractedTotal = checkedAdd(extractedTotal, written);
                require(extractedTotal <= extractedBytesCeiling);
                consumer.accept(approved, content.toByteArray());
            }
            require(input.getNextEntry() == null);
            require(input.read() == -1);
        }
        require(extractedTotal == inventory.extractedBytes);
        return extractedTotal;
    }

    private static Map<String, FileDeclaration> declaredFiles(ManifestInventory manifest) throws IOException {
        require(!manifest.files.isEmpty() && manifest.files.size() <= manifest.fileCountCeiling);
        Map<String, FileDeclaration> result = new HashMap<>();
        Set<String> folded = new HashSet<>();
        for (FileDeclaration file : manifest.files) {
            validatePath(file.path, manifest);
            require(file.bytes >= 0 && file.sha256.matches("^[0-9a-f]{64}$"));
            require(result.put(file.path, file) == null);
            require(folded.add(Normalizer.normalize(file.path, Normalizer.Form.NFC).toLowerCase(Locale.ROOT)));
        }
        return result;
    }

    private static void validatePath(String path, ManifestInventory manifest) throws IOException {
        require(path != null && !path.isEmpty() && path.equals(Normalizer.normalize(path, Normalizer.Form.NFC)));
        require(StandardCharsets.US_ASCII.newEncoder().canEncode(path) && SAFE_PATH.matcher(path).matches());
        require(!path.startsWith("/") && !path.contains("\\") && !path.endsWith("/"));
        String[] segments = path.split("/", -1);
        for (String segment : segments) require(!segment.isEmpty() && !segment.equals(".") && !segment.equals("..") && !segment.startsWith("."));
        int dot = path.lastIndexOf('.');
        require(dot >= 0);
        String extension = path.substring(dot);
        require(ALLOWED_EXTENSIONS.contains(extension) && manifest.allowedExtensions.contains(extension));
    }

    private static String strictAsciiUtf8(byte[] bytes) throws IOException {
        for (byte value : bytes) require((value & 0x80) == 0);
        String value = new String(bytes, StandardCharsets.UTF_8);
        require(java.util.Arrays.equals(value.getBytes(StandardCharsets.UTF_8), bytes));
        return value;
    }

    private static void requireTiledLocalRecords(List<RangeRecord> ranges, int centralOffset) throws IOException {
        ranges.sort(Comparator.comparingInt(value -> value.start));
        int cursor = 0;
        for (RangeRecord range : ranges) {
            require(range.start == cursor && range.end > range.start);
            cursor = range.end;
        }
        require(cursor == centralOffset);
    }

    private static void requireNoOverlap(List<RangeRecord> ranges) throws IOException {
        ranges.sort(Comparator.comparingInt(value -> value.start));
        for (int index = 1; index < ranges.size(); index += 1) {
            require(ranges.get(index).start >= ranges.get(index - 1).end);
        }
    }

    private static List<Integer> signatureOffsets(long signature, byte[] bytes) {
        List<Integer> result = new ArrayList<>();
        for (int offset = 0; offset <= bytes.length - 4; offset += 1) {
            if (read32(bytes, offset) == signature) result.add(offset);
        }
        return result;
    }

    private static int checkedAdd(int left, int right) throws IOException {
        try { return Math.addExact(left, right); } catch (ArithmeticException error) { throw rejected(); }
    }

    private static byte[] slice(byte[] bytes, int start, int end) throws IOException {
        require(start >= 0 && end >= start && end <= bytes.length);
        return java.util.Arrays.copyOfRange(bytes, start, end);
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return output.toString();
    }

    private static int read16(byte[] bytes, int offset) {
        if (offset < 0 || offset + 2 > bytes.length) return -1;
        return (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8);
    }

    private static long read32(byte[] bytes, int offset) {
        if (offset < 0 || offset + 4 > bytes.length) return -1;
        return ((long) bytes[offset] & 0xffL)
            | (((long) bytes[offset + 1] & 0xffL) << 8)
            | (((long) bytes[offset + 2] & 0xffL) << 16)
            | (((long) bytes[offset + 3] & 0xffL) << 24);
    }

    private static void require(boolean condition) throws IOException {
        if (!condition) throw rejected();
    }

    private static IOException rejected() { return new IOException("Pack archive rejected."); }

    private static final class RangeRecord {
        final int start;
        final int end;
        RangeRecord(int start, int end) { this.start = start; this.end = end; }
    }

    public static final class FileDeclaration {
        public final String path;
        public final int bytes;
        public final String sha256;
        public FileDeclaration(String path, int bytes, String sha256) {
            this.path = path;
            this.bytes = bytes;
            this.sha256 = sha256;
        }
    }

    public static final class ManifestInventory {
        public final int schemaVersion;
        public final int archiveBytes;
        public final int fileCountCeiling;
        public final int compressedBytesCeiling;
        public final int extractedBytesCeiling;
        public final List<String> allowedExtensions;
        public final List<FileDeclaration> files;
        public ManifestInventory(int schemaVersion, int archiveBytes, int fileCountCeiling,
            int compressedBytesCeiling, int extractedBytesCeiling,
            List<String> allowedExtensions, List<FileDeclaration> files) {
            this.schemaVersion = schemaVersion;
            this.archiveBytes = archiveBytes;
            this.fileCountCeiling = fileCountCeiling;
            this.compressedBytesCeiling = compressedBytesCeiling;
            this.extractedBytesCeiling = extractedBytesCeiling;
            this.allowedExtensions = Collections.unmodifiableList(new ArrayList<>(allowedExtensions));
            this.files = Collections.unmodifiableList(new ArrayList<>(files));
        }
    }

    public static final class Entry {
        public final String path;
        public final int method;
        public final long crc32;
        public final int compressedBytes;
        public final int extractedBytes;
        public final String sha256;
        Entry(String path, int method, long crc32, int compressedBytes, int extractedBytes,
            String sha256) {
            this.path = path;
            this.method = method;
            this.crc32 = crc32;
            this.compressedBytes = compressedBytes;
            this.extractedBytes = extractedBytes;
            this.sha256 = sha256;
        }
    }

    @FunctionalInterface
    public interface VerifiedEntryConsumer {
        void accept(Entry entry, byte[] content) throws Exception;
    }

    public static final class Inventory {
        public final List<Entry> entries;
        public final int compressedBytes;
        public final int extractedBytes;
        Inventory(List<Entry> entries, int compressedBytes, int extractedBytes) {
            this.entries = Collections.unmodifiableList(new ArrayList<>(entries));
            this.compressedBytes = compressedBytes;
            this.extractedBytes = extractedBytes;
        }
    }
}
