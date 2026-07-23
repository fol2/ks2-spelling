import Capacitor
import CryptoKit
import Darwin
import Foundation

@objc(InstalledAudioPlugin)
public final class InstalledAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "InstalledAudioPlugin"
    public let jsName = "InstalledAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "readInstalledAudio", returnType: CAPPluginReturnPromise)
    ]

    private static let maximumAudioBytes = 131_072
    private static let safeIdentifier = "^[a-z0-9][a-z0-9._-]{0,63}$"
    private static let safeAudioPath =
        "^audio/(iapetus|sulafat)/[a-z0-9][a-z0-9._-]{0,63}/" +
        "(word|sentence-[0-9]{2}-(normal|slow))\\.m4a$"
    private let worker = DispatchQueue(label: "uk.eugnel.ks2spelling.installed-audio")
    private let fileManager = FileManager.default

    @objc public func readInstalledAudio(_ call: CAPPluginCall) {
        worker.async {
            do {
                try self.requireKeys(
                    call,
                    exactly: ["packId", "version", "assetPath", "sha256", "byteSize"]
                )
                guard let packId = call.getString("packId"),
                      let version = call.getString("version"),
                      let assetPath = call.getString("assetPath"),
                      let expectedSha256 = call.getString("sha256"),
                      let byteSize = call.getInt("byteSize"),
                      byteSize > 0,
                      byteSize <= Self.maximumAudioBytes,
                      self.matches(packId, Self.safeIdentifier),
                      self.matches(version, Self.safeIdentifier),
                      self.matches(assetPath, Self.safeAudioPath),
                      self.matches(expectedSha256, "^[0-9a-f]{64}$") else {
                    throw InstalledAudioError.rejected
                }

                let support = try self.fileManager.url(
                    for: .applicationSupportDirectory,
                    in: .userDomainMask,
                    appropriateFor: nil,
                    create: true
                )
                let applicationRoot = support
                    .appendingPathComponent("KS2Spelling", isDirectory: true)
                let packRoot = applicationRoot
                    .appendingPathComponent("Packs", isDirectory: true)
                let installedRoot = packRoot
                    .appendingPathComponent("installed", isDirectory: true)
                let packURL = installedRoot
                    .appendingPathComponent(packId, isDirectory: true)
                let versionURL = packURL
                    .appendingPathComponent(version, isDirectory: true)
                try self.requireDirectoryChain([
                    support,
                    applicationRoot,
                    packRoot,
                    installedRoot,
                    packURL,
                    versionURL
                ])

                let markerURL = versionURL.appendingPathComponent("activation.json")
                let markerBytes = try self.readRegularFile(
                    markerURL,
                    expectedBytes: nil,
                    maximumBytes: 16_384
                )
                let marker = try JSONDecoder().decode(
                    InstalledAudioActivationMarker.self,
                    from: markerBytes
                )
                guard marker.packId == packId,
                      marker.version == version,
                      self.matches(marker.manifestSha256, "^[0-9a-f]{64}$"),
                      try self.encodedMarker(marker) == markerBytes else {
                    throw InstalledAudioError.rejected
                }

                let extracted = versionURL.appendingPathComponent(
                    "extracted",
                    isDirectory: true
                )
                var current = extracted
                var directories = [extracted]
                let components = assetPath.split(separator: "/").map(String.init)
                guard !components.isEmpty else { throw InstalledAudioError.rejected }
                for component in components.dropLast() {
                    current.appendPathComponent(component, isDirectory: true)
                    directories.append(current)
                }
                try self.requireDirectoryChain(directories)
                let assetURL = current.appendingPathComponent(
                    components.last!,
                    isDirectory: false
                )
                let audioBytes = try self.readRegularFile(
                    assetURL,
                    expectedBytes: byteSize,
                    maximumBytes: Self.maximumAudioBytes
                )
                guard self.sha256(audioBytes) == expectedSha256 else {
                    throw InstalledAudioError.rejected
                }
                call.resolve([
                    "base64": audioBytes.base64EncodedString()
                ])
            } catch {
                call.reject(
                    "Installed audio rejected.",
                    InstalledAudioError.rejected.safeCode
                )
            }
        }
    }

    private func requireKeys(_ call: CAPPluginCall, exactly expected: Set<String>) throws {
        let keys = Set(call.options.keys.compactMap { $0 as? String })
        guard keys == expected, call.options.keys.count == keys.count else {
            throw InstalledAudioError.rejected
        }
    }

    private func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    private func requireDirectoryChain(_ directories: [URL]) throws {
        for directory in directories {
            var information = stat()
            guard lstat(directory.path, &information) == 0,
                  information.st_mode & S_IFMT == S_IFDIR else {
                throw InstalledAudioError.rejected
            }
        }
    }

    private func readRegularFile(
        _ url: URL,
        expectedBytes: Int?,
        maximumBytes: Int
    ) throws -> Data {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw InstalledAudioError.rejected }
        defer { Darwin.close(descriptor) }
        var information = stat()
        guard fstat(descriptor, &information) == 0 else {
            throw InstalledAudioError.rejected
        }
        let expectedSizeMatches = expectedBytes.map {
            information.st_size == $0
        } ?? true
        guard information.st_mode & S_IFMT == S_IFREG,
              information.st_size >= 0,
              information.st_size <= maximumBytes,
              expectedSizeMatches else {
            throw InstalledAudioError.rejected
        }
        let count = Int(information.st_size)
        var data = Data(count: count)
        try data.withUnsafeMutableBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else {
                if count == 0 { return }
                throw InstalledAudioError.rejected
            }
            var offset = 0
            while offset < count {
                let received = Darwin.read(
                    descriptor,
                    base.advanced(by: offset),
                    count - offset
                )
                guard received > 0 else { throw InstalledAudioError.rejected }
                offset += received
            }
        }
        var sentinel: UInt8 = 0
        guard Darwin.read(descriptor, &sentinel, 1) == 0 else {
            throw InstalledAudioError.rejected
        }
        return data
    }

    private func encodedMarker(_ marker: InstalledAudioActivationMarker) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var bytes = try encoder.encode(marker)
        bytes.append(0x0a)
        return bytes
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

private struct InstalledAudioActivationMarker: Codable {
    let manifestSha256: String
    let packId: String
    let version: String
}

private enum InstalledAudioError: Error {
    case rejected

    var safeCode: String { "INSTALLED_AUDIO_REJECTED" }
}
