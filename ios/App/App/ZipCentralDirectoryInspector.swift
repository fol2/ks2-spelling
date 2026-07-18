import Foundation

struct PackArchiveManifest: Decodable {
    struct ArchiveIdentity: Decodable {
        let bytes: Int
        let name: String
        let sha256: String
    }

    struct Ceilings: Decodable {
        let compressedBytes: Int
        let extractedBytes: Int
        let fileCount: Int
    }

    struct FileRecord: Decodable {
        let bytes: Int
        let path: String
        let sha256: String
    }

    let allowedExtensions: [String]
    let archive: ArchiveIdentity
    let ceilings: Ceilings
    let files: [FileRecord]
    let packId: String
    let requiredEntitlementId: String
    let schemaVersion: Int
    let version: String
}

struct InspectedPackInventory {
    struct Entry {
        let path: String
        let compressedBytes: Int
        let extractedBytes: Int
        let sha256: String
    }

    let entries: [Entry]
    let compressedBytes: Int
    let extractedBytes: Int
}

enum PackInspectionError: Error {
    case rejected
}

enum PackCapabilityValidator {
    private static let safeIdentifier = try! NSRegularExpression(
        pattern: "^[a-z0-9][a-z0-9._-]{0,63}$"
    )
    private static let archiveName = try! NSRegularExpression(
        pattern: "^[a-z0-9][a-z0-9._-]{0,119}\\.zip$"
    )

    static func validateIdentifier(_ value: String) throws {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard safeIdentifier.firstMatch(in: value, range: range)?.range == range else {
            throw PackInspectionError.rejected
        }
    }

    static func validateArchiveName(_ value: String) throws {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard archiveName.firstMatch(in: value, range: range)?.range == range else {
            throw PackInspectionError.rejected
        }
    }

    static func validateCapabilityURL(
        _ capability: String,
        packId: String,
        version: String,
        archiveName: String
    ) throws -> URL {
        try validateIdentifier(packId)
        try validateIdentifier(version)
        try validateArchiveName(archiveName)
        guard capability.utf8.count <= 8_192,
              let components = URLComponents(string: capability),
              components.scheme == "https",
              components.host == "b3-gateway.eugnel.uk",
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.fragment == nil else {
            throw PackInspectionError.rejected
        }
        let expectedPath = "/v1/packs/\(packId)/\(version)/\(archiveName)"
        guard components.percentEncodedPath == expectedPath,
              let query = components.percentEncodedQuery else {
            throw PackInspectionError.rejected
        }
        let queryExpression = try! NSRegularExpression(
            pattern: "^expires=([1-9][0-9]*)&cap=([A-Za-z0-9_-]{43})$"
        )
        let range = NSRange(query.startIndex..<query.endIndex, in: query)
        guard let match = queryExpression.firstMatch(in: query, range: range),
              match.range == range,
              let expiresRange = Range(match.range(at: 1), in: query),
              let expires = UInt64(query[expiresRange]),
              expires > 0,
              let url = components.url,
              url.absoluteString == capability,
              url.absoluteString == "https://b3-gateway.eugnel.uk\(expectedPath)?\(query)" else {
            throw PackInspectionError.rejected
        }
        return url
    }
}

struct ValidatedPackRange {
    let status: Int
    let startByte: Int
    let endByteExclusive: Int
    let totalBytes: Int
    let etag: String
}

enum PackRangeResponseValidator {
    static func validate(
        statusCode: Int,
        responseURL: URL?,
        expectedURL: URL,
        etag: String?,
        contentRange: String?,
        bodyBytes: Int,
        requestedStart: Int,
        requestedEndExclusive: Int
    ) throws -> ValidatedPackRange {
        guard responseURL?.absoluteString == expectedURL.absoluteString,
              let etag,
              !etag.isEmpty,
              etag.utf8.count <= 256,
              bodyBytes > 0,
              bodyBytes <= 1_048_576 else {
            throw PackInspectionError.rejected
        }
        if statusCode == 200 {
            return ValidatedPackRange(
                status: 200,
                startByte: 0,
                endByteExclusive: bodyBytes,
                totalBytes: bodyBytes,
                etag: etag
            )
        }
        guard statusCode == 206, let contentRange else {
            throw PackInspectionError.rejected
        }
        let expression = try! NSRegularExpression(pattern: "^bytes ([0-9]+)-([0-9]+)/([1-9][0-9]*)$")
        let range = NSRange(contentRange.startIndex..<contentRange.endIndex, in: contentRange)
        guard let match = expression.firstMatch(in: contentRange, range: range),
              match.range == range,
              let startRange = Range(match.range(at: 1), in: contentRange),
              let endRange = Range(match.range(at: 2), in: contentRange),
              let totalRange = Range(match.range(at: 3), in: contentRange),
              let start = Int(contentRange[startRange]),
              let inclusiveEnd = Int(contentRange[endRange]),
              let total = Int(contentRange[totalRange]),
              start == requestedStart,
              inclusiveEnd >= start,
              inclusiveEnd < total,
              inclusiveEnd + 1 == min(requestedEndExclusive, total),
              bodyBytes == inclusiveEnd - start + 1 else {
            throw PackInspectionError.rejected
        }
        return ValidatedPackRange(
            status: 206,
            startByte: start,
            endByteExclusive: inclusiveEnd + 1,
            totalBytes: total,
            etag: etag
        )
    }
}

enum ZipCentralDirectoryInspector {
    private static let endSignature: UInt32 = 0x06054b50
    private static let centralSignature: UInt32 = 0x02014b50
    private static let localSignature: UInt32 = 0x04034b50
    private static let utf8Flag: UInt16 = 0x0800
    private static let regularMode: UInt16 = 0o100644
    private static let allowedExtensions = Set([".json", ".m4a"])

    private struct RangeRecord {
        let start: Int
        let end: Int
    }

    static func inspect(
        archiveURL: URL,
        manifest: PackArchiveManifest
    ) throws -> InspectedPackInventory {
        guard manifest.schemaVersion == 1,
              manifest.ceilings.fileCount > 0,
              manifest.ceilings.fileCount <= 16,
              manifest.ceilings.compressedBytes > 0,
              manifest.ceilings.compressedBytes <= 1_048_576,
              manifest.ceilings.extractedBytes > 0,
              manifest.ceilings.extractedBytes <= 4_194_304,
              Set(manifest.allowedExtensions) == allowedExtensions else {
            throw PackInspectionError.rejected
        }
        let data = try Data(contentsOf: archiveURL, options: [.mappedIfSafe])
        guard data.count == manifest.archive.bytes,
              data.count <= manifest.ceilings.compressedBytes,
              data.count >= 22 else {
            throw PackInspectionError.rejected
        }
        let bytes = [UInt8](data)
        let endOffsets = signatureOffsets(endSignature, in: bytes)
        guard endOffsets.count == 1, let endOffset = endOffsets.first,
              endOffset + 22 == bytes.count,
              read16(bytes, endOffset + 4) == 0,
              read16(bytes, endOffset + 6) == 0,
              read16(bytes, endOffset + 8) == read16(bytes, endOffset + 10),
              read16(bytes, endOffset + 20) == 0 else {
            throw PackInspectionError.rejected
        }
        let entryCount = Int(read16(bytes, endOffset + 10))
        let centralSize = Int(read32(bytes, endOffset + 12))
        let centralOffset = Int(read32(bytes, endOffset + 16))
        guard entryCount > 0,
              entryCount <= manifest.ceilings.fileCount,
              centralOffset >= 0,
              centralSize >= 0,
              centralOffset.addingReportingOverflow(centralSize).overflow == false,
              centralOffset + centralSize == endOffset else {
            throw PackInspectionError.rejected
        }

        let declared = try declaredFiles(manifest)
        var seenPaths = Set<String>()
        var foldedPaths = Set<String>()
        var localOffsets = Set<Int>()
        var localRanges: [RangeRecord] = []
        var dataRanges: [RangeRecord] = []
        var entries: [InspectedPackInventory.Entry] = []
        var compressedTotal = 0
        var extractedTotal = 0
        var cursor = centralOffset

        for _ in 0..<entryCount {
            guard cursor + 46 <= endOffset,
                  read32(bytes, cursor) == centralSignature else {
                throw PackInspectionError.rejected
            }
            let madeBy = read16(bytes, cursor + 4)
            let versionNeeded = read16(bytes, cursor + 6)
            let centralFlags = read16(bytes, cursor + 8)
            let centralMethod = read16(bytes, cursor + 10)
            let centralCRC = read32(bytes, cursor + 16)
            let compressedBytes = Int(read32(bytes, cursor + 20))
            let extractedBytes = Int(read32(bytes, cursor + 24))
            let nameLength = Int(read16(bytes, cursor + 28))
            let extraLength = Int(read16(bytes, cursor + 30))
            let commentLength = Int(read16(bytes, cursor + 32))
            let diskStart = read16(bytes, cursor + 34)
            let internalAttributes = read16(bytes, cursor + 36)
            let externalAttributes = read32(bytes, cursor + 38)
            let localOffset = Int(read32(bytes, cursor + 42))
            let recordEnd = cursor + 46 + nameLength + extraLength + commentLength
            guard madeBy >> 8 == 3,
                  versionNeeded <= 20,
                  centralFlags == utf8Flag,
                  centralMethod == 0 || centralMethod == 8,
                  compressedBytes != Int(UInt32.max),
                  extractedBytes != Int(UInt32.max),
                  nameLength > 0,
                  extraLength == 0,
                  commentLength == 0,
                  diskStart == 0,
                  internalAttributes == 0,
                  UInt16(externalAttributes >> 16) == regularMode,
                  recordEnd <= endOffset,
                  localOffset < centralOffset,
                  localOffsets.insert(localOffset).inserted else {
                throw PackInspectionError.rejected
            }
            let centralNameBytes = Array(bytes[(cursor + 46)..<(cursor + 46 + nameLength)])
            guard let path = String(bytes: centralNameBytes, encoding: .utf8) else {
                throw PackInspectionError.rejected
            }
            try validatePath(path, manifest: manifest)
            let folded = path.precomposedStringWithCanonicalMapping.lowercased()
            guard seenPaths.insert(path).inserted,
                  foldedPaths.insert(folded).inserted,
                  let declaration = declared[path],
                  declaration.bytes == extractedBytes else {
                throw PackInspectionError.rejected
            }

            guard localOffset + 30 <= centralOffset,
                  read32(bytes, localOffset) == localSignature else {
                throw PackInspectionError.rejected
            }
            let localNameLength = Int(read16(bytes, localOffset + 26))
            let localExtraLength = Int(read16(bytes, localOffset + 28))
            let dataStart = localOffset + 30 + localNameLength + localExtraLength
            let dataEnd = dataStart.addingReportingOverflow(compressedBytes)
            guard read16(bytes, localOffset + 4) == versionNeeded,
                  read16(bytes, localOffset + 6) == centralFlags,
                  read16(bytes, localOffset + 8) == centralMethod,
                  read16(bytes, localOffset + 10) == read16(bytes, cursor + 12),
                  read16(bytes, localOffset + 12) == read16(bytes, cursor + 14),
                  read32(bytes, localOffset + 14) == centralCRC,
                  read32(bytes, localOffset + 18) == UInt32(compressedBytes),
                  read32(bytes, localOffset + 22) == UInt32(extractedBytes),
                  localNameLength == nameLength,
                  localExtraLength == 0,
                  dataEnd.overflow == false,
                  dataEnd.partialValue <= centralOffset,
                  Array(bytes[(localOffset + 30)..<(localOffset + 30 + localNameLength)]) == centralNameBytes else {
                throw PackInspectionError.rejected
            }
            localRanges.append(RangeRecord(start: localOffset, end: dataEnd.partialValue))
            dataRanges.append(RangeRecord(start: dataStart, end: dataEnd.partialValue))
            compressedTotal = try checkedTotal(compressedTotal, compressedBytes)
            extractedTotal = try checkedTotal(extractedTotal, extractedBytes)
            entries.append(.init(
                path: path,
                compressedBytes: compressedBytes,
                extractedBytes: extractedBytes,
                sha256: declaration.sha256
            ))
            cursor = recordEnd
        }

        guard cursor == endOffset,
              entries.count == declared.count,
              compressedTotal <= manifest.ceilings.compressedBytes,
              extractedTotal <= manifest.ceilings.extractedBytes else {
            throw PackInspectionError.rejected
        }
        try requireTiledLocalRecords(localRanges, centralOffset: centralOffset)
        try requireNoOverlap(dataRanges)
        return InspectedPackInventory(
            entries: entries,
            compressedBytes: compressedTotal,
            extractedBytes: extractedTotal
        )
    }

    private static func declaredFiles(
        _ manifest: PackArchiveManifest
    ) throws -> [String: PackArchiveManifest.FileRecord] {
        guard manifest.files.count <= manifest.ceilings.fileCount else {
            throw PackInspectionError.rejected
        }
        var result: [String: PackArchiveManifest.FileRecord] = [:]
        var folded = Set<String>()
        for file in manifest.files {
            try validatePath(file.path, manifest: manifest)
            guard file.bytes >= 0,
                  file.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                  result[file.path] == nil,
                  folded.insert(file.path.precomposedStringWithCanonicalMapping.lowercased()).inserted else {
                throw PackInspectionError.rejected
            }
            result[file.path] = file
        }
        return result
    }

    private static func validatePath(
        _ path: String,
        manifest: PackArchiveManifest
    ) throws {
        guard !path.isEmpty,
              path == path.precomposedStringWithCanonicalMapping,
              path.utf8.allSatisfy({ $0 < 128 }),
              path.range(
                of: "^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$",
                options: .regularExpression
              ) != nil,
              !path.hasPrefix("/"),
              !path.contains("\\"),
              !path.hasSuffix("/"),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: {
                  $0.isEmpty || $0 == "." || $0 == ".." || $0.hasPrefix(".")
              }),
              let dot = path.lastIndex(of: ".") else {
            throw PackInspectionError.rejected
        }
        let suffix = String(path[dot...])
        guard allowedExtensions.contains(suffix), manifest.allowedExtensions.contains(suffix) else {
            throw PackInspectionError.rejected
        }
    }

    private static func checkedTotal(_ total: Int, _ value: Int) throws -> Int {
        guard value >= 0 else { throw PackInspectionError.rejected }
        let sum = total.addingReportingOverflow(value)
        guard !sum.overflow else { throw PackInspectionError.rejected }
        return sum.partialValue
    }

    private static func requireTiledLocalRecords(
        _ ranges: [RangeRecord],
        centralOffset: Int
    ) throws {
        let sorted = ranges.sorted { $0.start < $1.start }
        var cursor = 0
        for range in sorted {
            guard range.start == cursor, range.end > range.start else {
                throw PackInspectionError.rejected
            }
            cursor = range.end
        }
        guard cursor == centralOffset else { throw PackInspectionError.rejected }
    }

    private static func requireNoOverlap(_ ranges: [RangeRecord]) throws {
        let sorted = ranges.sorted { $0.start < $1.start }
        for index in 1..<sorted.count where sorted[index].start < sorted[index - 1].end {
            throw PackInspectionError.rejected
        }
    }

    private static func signatureOffsets(_ signature: UInt32, in bytes: [UInt8]) -> [Int] {
        guard bytes.count >= 4 else { return [] }
        return (0...(bytes.count - 4)).filter { read32(bytes, $0) == signature }
    }

    private static func read16(_ bytes: [UInt8], _ offset: Int) -> UInt16 {
        UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
    }

    private static func read32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        UInt32(bytes[offset]) |
            (UInt32(bytes[offset + 1]) << 8) |
            (UInt32(bytes[offset + 2]) << 16) |
            (UInt32(bytes[offset + 3]) << 24)
    }
}
