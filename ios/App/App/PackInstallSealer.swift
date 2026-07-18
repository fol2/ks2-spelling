import Darwin
import Foundation

struct ActivationMarker: Codable, Equatable {
    let manifestSha256: String
    let packId: String
    let version: String
}

struct PackSealEvidence: Equatable {
    let installedPathToken: String
    let activationMarkerSha256: String
}

enum PackInstallSealer {
    static func seal(
        staging: URL,
        installed: URL,
        marker: ActivationMarker,
        evidence: PackSealEvidence,
        validateStaging: () throws -> Void
    ) throws -> PackSealEvidence {
        if try pathExists(installed) {
            try requireDirectory(installed)
            guard try readMarker(at: installed.appendingPathComponent("activation.json")) == marker else {
                throw PackTransferError.rejected
            }
            return evidence
        }

        try validateStaging()
        try requireDirectory(staging)
        let markerURL = staging.appendingPathComponent("activation.json")
        if try pathExists(markerURL) {
            guard try readMarker(at: markerURL) == marker else {
                throw PackTransferError.rejected
            }
        } else {
            try createMarker(encodedMarker(marker), at: markerURL)
        }
        guard try readMarker(at: markerURL) == marker else {
            throw PackTransferError.rejected
        }
        do {
            try FileManager.default.moveItem(at: staging, to: installed)
        } catch {
            throw PackTransferError.rejected
        }
        return evidence
    }

    static func encodedMarker(_ marker: ActivationMarker) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(marker)
        data.append(0x0a)
        return data
    }

    static func readMarker(at url: URL) throws -> ActivationMarker {
        let data = try readRegularFile(at: url, maximumBytes: 16_384)
        let object = try JSONSerialization.jsonObject(with: data)
        guard let dictionary = object as? [String: Any],
              Set(dictionary.keys) == Set(["manifestSha256", "packId", "version"]),
              let marker = try? JSONDecoder().decode(ActivationMarker.self, from: data),
              let canonical = try? encodedMarker(marker),
              data == canonical else {
            throw PackTransferError.rejected
        }
        return marker
    }

    private static func pathExists(_ url: URL) throws -> Bool {
        var information = stat()
        if lstat(url.path, &information) == 0 { return true }
        guard errno == ENOENT else { throw PackTransferError.rejected }
        return false
    }

    private static func requireDirectory(_ url: URL) throws {
        var information = stat()
        guard lstat(url.path, &information) == 0,
              information.st_mode & S_IFMT == S_IFDIR else {
            throw PackTransferError.rejected
        }
    }

    private static func createMarker(_ data: Data, at url: URL) throws {
        let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw PackTransferError.rejected }
        defer { Darwin.close(descriptor) }
        try writeAll(data, descriptor: descriptor)
        guard fsync(descriptor) == 0 else { throw PackTransferError.rejected }
    }

    private static func readRegularFile(at url: URL, maximumBytes: Int) throws -> Data {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw PackTransferError.rejected }
        defer { Darwin.close(descriptor) }
        var information = stat()
        guard fstat(descriptor, &information) == 0,
              information.st_mode & S_IFMT == S_IFREG,
              information.st_size >= 0,
              information.st_size <= maximumBytes else {
            throw PackTransferError.rejected
        }
        var result = Data(count: Int(information.st_size))
        var offset = 0
        try result.withUnsafeMutableBytes { buffer in
            while offset < buffer.count {
                guard let base = buffer.baseAddress else { throw PackTransferError.rejected }
                let count = Darwin.read(
                    descriptor,
                    base.advanced(by: offset),
                    buffer.count - offset
                )
                guard count > 0 else { throw PackTransferError.rejected }
                offset += count
            }
        }
        return result
    }

    private static func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(
                    descriptor,
                    base.advanced(by: offset),
                    buffer.count - offset
                )
                guard count > 0 else { throw PackTransferError.rejected }
                offset += count
            }
        }
    }
}
