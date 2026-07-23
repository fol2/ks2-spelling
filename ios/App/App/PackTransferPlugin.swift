import Capacitor
import CryptoKit
import Darwin
import Foundation
import ZIPFoundation

@objc(PackTransferPlugin)
public final class PackTransferPlugin: CAPPlugin, CAPBridgedPlugin {
    private static let freeStarterPackId = "ks2-core"
    private static let packEnvironment: String = {
#if B3_SANDBOX_PROOF
        "sandbox"
#else
        "production"
#endif
    }()

    public let identifier = "PackTransferPlugin"
    public let jsName = "PackTransfer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getFreeBytes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadRange", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "inspectAndExtract", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sealAndInstall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "inventoryInstalledVersions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeOwnedTemporaryState", returnType: CAPPluginReturnPromise)
    ]

    private let worker = DispatchQueue(label: "uk.eugnel.ks2spelling.pack-transfer")
    private let fileManager = FileManager.default

    @objc public func getFreeBytes(_ call: CAPPluginCall) {
        worker.async {
            self.perform(call) {
                try self.requireKeys(call, exactly: [])
                let root = try self.packRoot()
                let values = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
                guard let freeBytes = values.volumeAvailableCapacityForImportantUsage,
                      freeBytes >= 0 else { throw PackTransferError.rejected }
                call.resolve(["freeBytes": freeBytes])
            }
        }
    }

    @objc public func downloadRange(_ call: CAPPluginCall) {
        worker.async {
            self.perform(call) {
                try self.requireKeys(call, exactly: [
                    "capabilityUrl", "packId", "version", "archiveName",
                    "startByte", "endByteExclusive", "truncate"
                ])
                guard let capability = call.getString("capabilityUrl"),
                      let packId = call.getString("packId"),
                      let version = call.getString("version"),
                      let archiveName = call.getString("archiveName"),
                      let startByte = call.getInt("startByte"),
                      let endByteExclusive = call.getInt("endByteExclusive"),
                      let truncate = call.getBool("truncate"),
                      startByte >= 0,
                      endByteExclusive > startByte,
                      endByteExclusive <= 1_048_576,
                      !truncate || startByte == 0 else {
                    throw PackTransferError.rejected
                }
                var partialURL: URL?
                let outcome = try PackDownloadFlow.execute(
                    PackDownloadRequest(
                        capabilityURL: capability,
                        packId: packId,
                        version: version,
                        archiveName: archiveName,
                        startByte: startByte,
                        endByteExclusive: endByteExclusive,
                        truncate: truncate
                    ),
                    beforeTransport: {
                        let candidate = try self.partialArchiveURL(
                            packId: packId,
                            version: version,
                            archiveName: archiveName
                        )
                        try self.ensureOwnedDirectory(candidate.deletingLastPathComponent())
                        let currentBytes = try self.existingRegularFileBytes(candidate)
                        guard truncate || currentBytes >= startByte else {
                            throw PackTransferError.rejected
                        }
                        partialURL = candidate
                    },
                    transport: URLSessionPackDownloadTransport()
                )
                guard let partialURL else { throw PackTransferError.rejected }
                try self.writeRange(
                    outcome.response.data,
                    to: partialURL,
                    startByte: outcome.range.startByte,
                    truncate: truncate || outcome.range.status == 200
                )
                call.resolve([
                    "status": outcome.range.status,
                    "startByte": outcome.range.startByte,
                    "endByteExclusive": outcome.range.endByteExclusive,
                    "totalBytes": outcome.range.totalBytes,
                    "bytesWritten": outcome.response.data.count,
                    "etag": outcome.range.etag
                ])
            }
        }
    }

    @objc public func inspectAndExtract(_ call: CAPPluginCall) {
        worker.async {
            self.perform(call) {
                try self.requireKeys(call, exactly: [
                    "packId", "version", "archiveName", "signedManifestEnvelopeBase64"
                ])
                guard let packId = call.getString("packId"),
                      let version = call.getString("version"),
                      let archiveName = call.getString("archiveName"),
                      let envelopeBase64 = call.getString("signedManifestEnvelopeBase64"),
                      envelopeBase64.utf8.count <= 1_048_576,
                      let envelopeBytes = Data(base64Encoded: envelopeBase64) else {
                    throw PackTransferError.rejected
                }
                try PackCapabilityValidator.validateIdentifier(packId)
                try PackCapabilityValidator.validateIdentifier(version)
                try PackCapabilityValidator.validateArchiveName(archiveName)
                let verified = try self.verifySignedManifest(envelopeBytes)
                guard verified.manifest.packId == packId,
                      verified.manifest.version == version,
                      verified.manifest.archive.name == archiveName else {
                    throw PackTransferError.rejected
                }
                let archiveURL = try self.partialArchiveURL(
                    packId: packId,
                    version: version,
                    archiveName: archiveName
                )
                try self.ensureOwnedDirectory(archiveURL.deletingLastPathComponent())
                try ZipCentralDirectoryInspector.validateManifestCeilings(verified.manifest)
                guard try self.existingRegularFileBytes(archiveURL) == verified.manifest.archive.bytes else {
                    throw PackTransferError.rejected
                }
                let archiveBytes = try Data(contentsOf: archiveURL, options: [.mappedIfSafe])
                guard self.sha256(archiveBytes) == verified.manifest.archive.sha256 else {
                    throw PackTransferError.rejected
                }
                let inventory = try ZipCentralDirectoryInspector.inspect(
                    archiveURL: archiveURL,
                    manifest: verified.manifest
                )
                // ZIPFoundation 0.9.20 is extraction machinery only. The owned byte-level
                // inspector above has already approved every member and byte range.
                let archive = try Archive(url: archiveURL, accessMode: .read)
                let versionRoot = archiveURL.deletingLastPathComponent()
                let extractionRoot = versionRoot.appendingPathComponent("extracted", isDirectory: true)
                if self.fileManager.fileExists(atPath: extractionRoot.path) {
                    try self.fileManager.removeItem(at: extractionRoot)
                }
                try self.ensureOwnedDirectory(extractionRoot)
                var extractedBytes = 0
                for inspected in inventory.entries {
                    guard let entry = archive[inspected.path], entry.type == .file else {
                        throw PackTransferError.rejected
                    }
                    var content = Data()
                    _ = try archive.extract(entry, bufferSize: 64 * 1_024, skipCRC32: false) { chunk in
                        let next = extractedBytes + content.count + chunk.count
                        guard next <= verified.manifest.ceilings.extractedBytes,
                              content.count + chunk.count <= inspected.extractedBytes else {
                            throw PackTransferError.rejected
                        }
                        content.append(chunk)
                    }
                    guard content.count == inspected.extractedBytes,
                          self.sha256(content) == inspected.sha256 else {
                        throw PackTransferError.rejected
                    }
                    extractedBytes += content.count
                    let destination = extractionRoot.appendingPathComponent(inspected.path)
                    try self.ensureOwnedDirectory(destination.deletingLastPathComponent())
                    try self.createRegularFileWithoutFollowingLinks(content, at: destination)
                }
                let manifestSha256 = self.sha256(envelopeBytes)
                let inspection = InspectionMarker(
                    manifestSha256: manifestSha256,
                    archiveSha256: verified.manifest.archive.sha256,
                    extractedBytes: extractedBytes,
                    fileCount: inventory.entries.count
                )
                try self.writeOwnedJSON(
                    inspection,
                    to: versionRoot.appendingPathComponent("inspection.json")
                )
                call.resolve([
                    "archiveSha256": verified.manifest.archive.sha256,
                    "manifestSha256": manifestSha256,
                    "extractedBytes": extractedBytes,
                    "fileCount": inventory.entries.count,
                    "stagingToken": "staging/\(packId)/\(version)"
                ])
            }
        }
    }

    @objc public func sealAndInstall(_ call: CAPPluginCall) {
        worker.async {
            self.perform(call) {
                try self.requireKeys(call, exactly: ["packId", "version", "manifestSha256"])
                guard let packId = call.getString("packId"),
                      let version = call.getString("version"),
                      let manifestSha256 = call.getString("manifestSha256"),
                      self.isSha256(manifestSha256) else {
                    throw PackTransferError.rejected
                }
                let installed = try self.installedVersionURL(packId: packId, version: version)
                try self.ensureOwnedDirectory(installed.deletingLastPathComponent())
                let marker = ActivationMarker(
                    manifestSha256: manifestSha256,
                    packId: packId,
                    version: version
                )
                let markerData = try PackInstallSealer.encodedMarker(marker)
                let evidence = PackSealEvidence(
                    installedPathToken: "installed/\(packId)/\(version)",
                    activationMarkerSha256: self.sha256(markerData)
                )
                let staging = try self.stagingVersionURL(packId: packId, version: version)
                let result = try PackInstallSealer.seal(
                    staging: staging,
                    installed: installed,
                    marker: marker,
                    evidence: evidence,
                    validateStaging: {
                        try self.ensureOwnedDirectory(staging)
                        let inspection: InspectionMarker = try self.readOwnedJSON(
                            InspectionMarker.self,
                            at: staging.appendingPathComponent("inspection.json")
                        )
                        guard inspection.manifestSha256 == manifestSha256 else {
                            throw PackTransferError.rejected
                        }
                        try self.requireDirectoryWithoutSymlink(
                            staging.appendingPathComponent("extracted", isDirectory: true)
                        )
                    }
                )
                call.resolve([
                    "installedPathToken": result.installedPathToken,
                    "activationMarkerSha256": result.activationMarkerSha256
                ])
            }
        }
    }

    @objc public func inventoryInstalledVersions(_ call: CAPPluginCall) {
        worker.async {
            self.perform(call) {
                try self.requireKeys(call, exactly: [])
                let installedRoot = try self.packRoot()
                    .appendingPathComponent("installed", isDirectory: true)
                try self.ensureOwnedDirectory(installedRoot)
                var result: [[String: Any]] = []
                for packURL in try self.safeDirectoryChildren(installedRoot) {
                    let packId = packURL.lastPathComponent
                    try PackCapabilityValidator.validateIdentifier(packId)
                    for versionURL in try self.safeDirectoryChildren(packURL) {
                        let version = versionURL.lastPathComponent
                        try PackCapabilityValidator.validateIdentifier(version)
                        let markerURL = versionURL.appendingPathComponent("activation.json")
                        let marker = try PackInstallSealer.readMarker(at: markerURL)
                        let markerData = try PackInstallSealer.encodedMarker(marker)
                        guard marker.packId == packId,
                              marker.version == version,
                              self.isSha256(marker.manifestSha256) else {
                            throw PackTransferError.rejected
                        }
                        result.append([
                            "packId": packId,
                            "version": version,
                            "installedPathToken": "installed/\(packId)/\(version)",
                            "manifestSha256": marker.manifestSha256,
                            "activationMarkerSha256": self.sha256(markerData)
                        ])
                    }
                }
                result.sort {
                    (($0["packId"] as? String) ?? "", ($0["version"] as? String) ?? "") <
                        (($1["packId"] as? String) ?? "", ($1["version"] as? String) ?? "")
                }
                call.resolve(["versions": result])
            }
        }
    }

    @objc public func removeOwnedTemporaryState(_ call: CAPPluginCall) {
        worker.async {
            self.perform(call) {
                try self.requireKeys(call, exactly: ["packId", "version"])
                guard let packId = call.getString("packId"),
                      let version = call.getString("version") else {
                    throw PackTransferError.rejected
                }
                let staging = try self.stagingVersionURL(packId: packId, version: version)
                let existed = self.fileManager.fileExists(atPath: staging.path)
                if existed { try self.fileManager.removeItem(at: staging) }
                call.resolve(["removed": existed])
            }
        }
    }

    private func perform(_ call: CAPPluginCall, operation: () throws -> Void) {
        do {
            try operation()
        } catch let error as PackTransferError {
            call.reject("Pack transfer rejected.", error.safeCode)
        } catch {
            call.reject("Pack transfer rejected.", PackTransferError.rejected.safeCode)
        }
    }

    private func requireKeys(_ call: CAPPluginCall, exactly expected: Set<String>) throws {
        let keys = Set(call.options.keys.compactMap { $0 as? String })
        guard keys == expected, call.options.keys.count == keys.count else {
            throw PackTransferError.rejected
        }
    }

    private func packRoot() throws -> URL {
        let support = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let root = support
            .appendingPathComponent("KS2Spelling", isDirectory: true)
            .appendingPathComponent("Packs", isDirectory: true)
        try secureDirectoryChain(from: support, to: root)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableRoot = root
        try mutableRoot.setResourceValues(values)
        return root
    }

    private func stagingVersionURL(packId: String, version: String) throws -> URL {
        try PackCapabilityValidator.validateIdentifier(packId)
        try PackCapabilityValidator.validateIdentifier(version)
        return try packRoot()
            .appendingPathComponent("staging", isDirectory: true)
            .appendingPathComponent(packId, isDirectory: true)
            .appendingPathComponent(version, isDirectory: true)
    }

    private func installedVersionURL(packId: String, version: String) throws -> URL {
        try PackCapabilityValidator.validateIdentifier(packId)
        try PackCapabilityValidator.validateIdentifier(version)
        return try packRoot()
            .appendingPathComponent("installed", isDirectory: true)
            .appendingPathComponent(packId, isDirectory: true)
            .appendingPathComponent(version, isDirectory: true)
    }

    private func partialArchiveURL(
        packId: String,
        version: String,
        archiveName: String
    ) throws -> URL {
        try PackCapabilityValidator.validateArchiveName(archiveName)
        return try stagingVersionURL(packId: packId, version: version)
            .appendingPathComponent("\(archiveName).partial", isDirectory: false)
    }

    private func ensureOwnedDirectory(_ url: URL) throws {
        let root = try packRoot()
        let rootPath = root.standardizedFileURL.path
        let targetPath = url.standardizedFileURL.path
        guard targetPath == rootPath || targetPath.hasPrefix("\(rootPath)/") else {
            throw PackTransferError.rejected
        }
        try secureDirectoryChain(from: root, to: url)
    }

    private func secureDirectoryChain(from base: URL, to target: URL) throws {
        let basePath = base.standardizedFileURL.path
        let targetPath = target.standardizedFileURL.path
        guard targetPath == basePath || targetPath.hasPrefix("\(basePath)/") else {
            throw PackTransferError.rejected
        }
        try requireDirectoryWithoutSymlink(base)
        let suffix = targetPath.dropFirst(basePath.count)
            .split(separator: "/", omittingEmptySubsequences: true)
        var current = base
        for component in suffix {
            current.appendPathComponent(String(component), isDirectory: true)
            if Darwin.mkdir(current.path, 0o700) != 0, errno != EEXIST {
                throw PackTransferError.rejected
            }
            try requireDirectoryWithoutSymlink(current)
        }
    }

    private func requireDirectoryWithoutSymlink(_ url: URL) throws {
        var information = stat()
        guard lstat(url.path, &information) == 0,
              information.st_mode & S_IFMT == S_IFDIR else {
            throw PackTransferError.rejected
        }
    }

    private func existingRegularFileBytes(_ url: URL) throws -> Int {
        guard fileManager.fileExists(atPath: url.path) else { return 0 }
        let values = try url.resourceValues(forKeys: [
            .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey
        ])
        guard values.isRegularFile == true,
              values.isSymbolicLink != true,
              let size = values.fileSize else { throw PackTransferError.rejected }
        return size
    }

    private func writeRange(
        _ data: Data,
        to url: URL,
        startByte: Int,
        truncate: Bool
    ) throws {
        if truncate, fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
        if !fileManager.fileExists(atPath: url.path) {
            let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            guard descriptor >= 0 else { throw PackTransferError.rejected }
            Darwin.close(descriptor)
        }
        let descriptor = Darwin.open(url.path, O_WRONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw PackTransferError.rejected }
        defer { Darwin.close(descriptor) }
        guard ftruncate(descriptor, off_t(startByte)) == 0,
              lseek(descriptor, off_t(startByte), SEEK_SET) == off_t(startByte) else {
            throw PackTransferError.rejected
        }
        try writeAll(data, descriptor: descriptor)
        guard fsync(descriptor) == 0 else { throw PackTransferError.rejected }
    }

    private func createRegularFileWithoutFollowingLinks(_ data: Data, at url: URL) throws {
        let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw PackTransferError.rejected }
        defer { Darwin.close(descriptor) }
        try writeAll(data, descriptor: descriptor)
        guard fsync(descriptor) == 0 else { throw PackTransferError.rejected }
    }

    private func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            var written = 0
            while written < data.count {
                let count = Darwin.write(
                    descriptor,
                    base.advanced(by: written),
                    data.count - written
                )
                guard count > 0 else { throw PackTransferError.rejected }
                written += count
            }
        }
    }

    private func verifySignedManifest(_ envelopeBytes: Data) throws -> VerifiedManifest {
        let object = try JSONSerialization.jsonObject(with: envelopeBytes)
        guard let envelopeObject = object as? [String: Any],
              Set(envelopeObject.keys) == Set([
                "schemaVersion", "algorithm", "keyId", "payloadEncoding", "domain",
                "canonicalManifestBase64", "signatureDerBase64"
              ]),
              let envelope = try? JSONDecoder().decode(SignedManifestEnvelope.self, from: envelopeBytes),
              envelope.schemaVersion == 1,
              envelope.algorithm == "ECDSA_P256_SHA256_DER",
              envelope.payloadEncoding == "RFC8785_UTF8",
              envelope.domain == "ks2-spelling-pack-manifest-v1",
              let canonicalBytes = Data(base64Encoded: envelope.canonicalManifestBase64),
              let signatureBytes = Data(base64Encoded: envelope.signatureDerBase64),
              canonicalBytes.count <= 1_048_576 else {
            throw PackTransferError.rejected
        }
        let keyring = try loadKeyring()
        guard let key = keyring.keys.first(where: { $0.keyId == envelope.keyId }),
              keyring.keys.filter({ $0.keyId == envelope.keyId }).count == 1,
              key.algorithm == envelope.algorithm,
              key.testOnly == (Self.packEnvironment == "sandbox"),
              key.allowedEnvironments.contains(Self.packEnvironment),
              let keyBytes = Data(base64Encoded: key.publicKeySpkiDerBase64),
              sha256(keyBytes) == key.publicKeySpkiSha256,
              let notBefore = Self.iso8601.date(from: key.notBefore),
              let notAfter = Self.iso8601.date(from: key.notAfter),
              Date() >= notBefore,
              Date() <= notAfter else {
            throw PackTransferError.rejected
        }
        let publicKey = try P256.Signing.PublicKey(derRepresentation: keyBytes)
        let signature = try P256.Signing.ECDSASignature(derRepresentation: signatureBytes)
        var signingInput = Data("ks2-spelling-pack-manifest-v1".utf8)
        signingInput.append(0)
        signingInput.append(canonicalBytes)
        guard publicKey.isValidSignature(signature, for: signingInput) else {
            throw PackTransferError.rejected
        }
        let manifestObject = try JSONSerialization.jsonObject(with: canonicalBytes)
        guard let manifestDictionary = manifestObject as? [String: Any],
              Set(manifestDictionary.keys) == Set([
                "allowedExtensions", "archive", "ceilings", "files", "packId",
                "requiredEntitlementId", "schemaVersion", "version"
              ]),
              let rebuilt = try? JSONSerialization.data(
                withJSONObject: manifestDictionary,
                options: [.sortedKeys, .withoutEscapingSlashes]
              ),
              rebuilt == canonicalBytes,
              let manifest = try? JSONDecoder().decode(PackArchiveManifest.self, from: canonicalBytes),
              manifest.schemaVersion == 1,
              key.allowedPackIds.contains(manifest.packId),
              manifest.requiredEntitlementId == nil
                ? manifest.packId == Self.freeStarterPackId
                : manifest.requiredEntitlementId == "full-ks2",
              manifest.allowedExtensions == [".json", ".m4a"] else {
            throw PackTransferError.rejected
        }
        return VerifiedManifest(manifest: manifest)
    }

    private func loadKeyring() throws -> PackKeyring {
        guard let url = Bundle.main.url(
            forResource: "pack-signing-public-keys",
            withExtension: "json"
        ) else { throw PackTransferError.rejected }
        let bytes = try Data(contentsOf: url)
        let object = try JSONSerialization.jsonObject(with: bytes)
        guard let dictionary = object as? [String: Any],
              Set(dictionary.keys) == Set(["schemaVersion", "keys"]),
              let keyring = try? JSONDecoder().decode(PackKeyring.self, from: bytes),
              keyring.schemaVersion == 1,
              !keyring.keys.isEmpty else { throw PackTransferError.rejected }
        return keyring
    }

    private func safeDirectoryChildren(_ url: URL) throws -> [URL] {
        let children = try fileManager.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        )
        for child in children {
            let values = try child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw PackTransferError.rejected
            }
        }
        return children
    }

    private func encodedJSON<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(value)
        data.append(0x0a)
        return data
    }

    private func writeOwnedJSON<T: Encodable>(_ value: T, to url: URL) throws {
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
        try createRegularFileWithoutFollowingLinks(try encodedJSON(value), at: url)
    }

    private func readOwnedJSON<T: Decodable>(_ type: T.Type, at url: URL) throws -> T {
        guard try existingRegularFileBytes(url) <= 16_384 else {
            throw PackTransferError.rejected
        }
        return try JSONDecoder().decode(type, from: Data(contentsOf: url))
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func isSha256(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}

private final class URLSessionPackDownloadTransport: PackDownloadTransport {
    func fetch(_ request: URLRequest) throws -> DownloadResponse {
        let delegate = BoundedNoRedirectDelegate(maximumBytes: 1_048_576)
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        let session = URLSession(
            configuration: .ephemeral,
            delegate: delegate,
            delegateQueue: delegateQueue
        )
        let task = session.dataTask(with: request)
        task.resume()
        guard delegate.wait(timeout: .now() + 35) else {
            task.cancel()
            session.invalidateAndCancel()
            throw PackTransferError.rejected
        }
        session.finishTasksAndInvalidate()
        return try delegate.result()
    }
}

private final class BoundedNoRedirectDelegate: NSObject, URLSessionDataDelegate {
    private let maximumBytes: Int
    private let completion = DispatchSemaphore(value: 0)
    private var body = Data()
    private var response: HTTPURLResponse?
    private var failure: Error?

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
    }

    func wait(timeout: DispatchTime) -> Bool {
        completion.wait(timeout: timeout) == .success
    }

    func result() throws -> DownloadResponse {
        guard failure == nil, let response else { throw PackTransferError.rejected }
        return DownloadResponse(data: body, response: response)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let response = response as? HTTPURLResponse,
              response.expectedContentLength <= Int64(maximumBytes) else {
            failure = PackTransferError.rejected
            completionHandler(.cancel)
            return
        }
        self.response = response
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil, body.count + data.count <= maximumBytes else {
            failure = PackTransferError.rejected
            dataTask.cancel()
            return
        }
        body.append(data)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error, failure == nil { failure = error }
        completion.signal()
    }
}

private struct VerifiedManifest { let manifest: PackArchiveManifest }

private struct SignedManifestEnvelope: Decodable {
    let schemaVersion: Int
    let algorithm: String
    let keyId: String
    let payloadEncoding: String
    let domain: String
    let canonicalManifestBase64: String
    let signatureDerBase64: String
}

private struct PackKeyring: Decodable {
    struct Key: Decodable {
        let keyId: String
        let algorithm: String
        let publicKeySpkiDerBase64: String
        let publicKeySpkiSha256: String
        let testOnly: Bool
        let notBefore: String
        let notAfter: String
        let allowedEnvironments: [String]
        let allowedPackIds: [String]
    }
    let schemaVersion: Int
    let keys: [Key]
}

private struct InspectionMarker: Codable {
    let manifestSha256: String
    let archiveSha256: String
    let extractedBytes: Int
    let fileCount: Int
}
