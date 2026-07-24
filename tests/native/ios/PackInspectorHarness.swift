import Foundation
import ZIPFoundation

@main
enum PackInspectorHarness {
    static func main() throws {
        if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "security" {
            try runSecurityMatrix()
            print("security:pass")
            return
        }
        guard CommandLine.arguments.count == 4 else {
            throw NSError(domain: "PackInspectorHarness", code: 2)
        }
        let archiveURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let authorityData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let expected = CommandLine.arguments[3]
        let manifestBytes: Data
        if expected == "accept-unsigned" {
            manifestBytes = authorityData
        } else {
            let envelope = try JSONDecoder().decode(
                SignedEnvelopeFixture.self,
                from: authorityData
            )
            guard let decoded = Data(base64Encoded: envelope.canonicalManifestBase64) else {
                throw NSError(domain: "PackInspectorHarness", code: 3)
            }
            manifestBytes = decoded
        }
        let manifest = try JSONDecoder().decode(PackArchiveManifest.self, from: manifestBytes)
        do {
            let inventory = try ZipCentralDirectoryInspector.inspect(
                archiveURL: archiveURL,
                manifest: manifest
            )
            guard expected == "accept" || expected == "accept-unsigned" else {
                throw NSError(domain: "PackInspectorHarness", code: 4)
            }
            let extractionSmoke = try Archive(url: archiveURL, accessMode: .read)
            guard Array(extractionSmoke).count == inventory.entries.count else {
                throw NSError(domain: "PackInspectorHarness", code: 5)
            }
            print("accepted:\(inventory.entries.count)")
        } catch {
            guard expected == "reject" else { throw error }
            print("rejected")
        }
    }

    private static func runSecurityMatrix() throws {
        let cap = String(repeating: "A", count: 43)
        let valid = "https://b3-gateway.eugnel.uk/v1/packs/b3-sandbox-proof/1.0.0-b3.1/b3-sandbox-proof.zip?expires=1783900800&cap=\(cap)"
        let mutations = [
            valid.replacingOccurrences(of: "https:", with: "http:"),
            valid.replacingOccurrences(of: "b3-gateway.eugnel.uk", with: "evil.example"),
            valid.replacingOccurrences(of: "https://", with: "https://user:pass@"),
            valid.replacingOccurrences(of: ".uk/", with: ".uk:444/"),
            "\(valid)#fragment",
            "\(valid)&extra=1",
            valid.replacingOccurrences(of: "?expires=1783900800&cap=", with: "?cap=\(cap)&expires=1783900800&cap="),
            valid.replacingOccurrences(of: "expires=1783900800", with: "expires=01783900800"),
            valid.replacingOccurrences(of: "1.0.0-b3.1", with: "../1.0.0-b3.1")
        ]
        for mutation in mutations {
            let transport = SpyTransport(response: try response(status: 206, url: valid))
            do {
                _ = try PackDownloadFlow.execute(
                    PackDownloadRequest(
                        capabilityURL: mutation,
                        packId: "b3-sandbox-proof",
                        version: "1.0.0-b3.1",
                        archiveName: "b3-sandbox-proof.zip",
                        startByte: 0,
                        endByteExclusive: 100,
                        truncate: false
                    ),
                    beforeTransport: {},
                    transport: transport
                )
                throw NSError(domain: "PackInspectorHarness", code: 8)
            } catch let error as NSError where error.domain == "PackInspectorHarness" {
                throw error
            } catch {}
            guard transport.calls == 0 else {
                throw NSError(domain: "PackInspectorHarness", code: 6)
            }
        }
        guard let expectedURL = URL(string: valid) else {
            throw NSError(domain: "PackInspectorHarness", code: 6)
        }
        let validTransport = SpyTransport(response: try response(status: 206, url: valid))
        _ = try PackDownloadFlow.execute(
            PackDownloadRequest(
                capabilityURL: valid,
                packId: "b3-sandbox-proof",
                version: "1.0.0-b3.1",
                archiveName: "b3-sandbox-proof.zip",
                startByte: 0,
                endByteExclusive: 100,
                truncate: false
            ),
            beforeTransport: {},
            transport: validTransport
        )
        guard validTransport.calls == 1 else {
            throw NSError(domain: "PackInspectorHarness", code: 6)
        }
        guard validTransport.requests.count == 1,
              let builtRequest = validTransport.requests.first,
              builtRequest.httpMethod == "GET",
              builtRequest.value(forHTTPHeaderField: "Origin") == "capacitor://localhost",
              builtRequest.value(forHTTPHeaderField: "Range") == "bytes=0-99",
              builtRequest.value(forHTTPHeaderField: "Accept-Encoding") == "identity",
              builtRequest.allHTTPHeaderFields?.count == 3 else {
            throw NSError(domain: "PackInspectorHarness", code: 14)
        }
        _ = try PackRangeResponseValidator.validate(
            statusCode: 206,
            responseURL: expectedURL,
            expectedURL: expectedURL,
            etag: "fixed",
            contentRange: "bytes 0-99/1324",
            bodyBytes: 100,
            requestedStart: 0,
            requestedEndExclusive: 100
        )
        for mutation in [
            (URL(string: "https://evil.example/file")!, "bytes 0-99/1324", 100),
            (expectedURL, "bytes 0-49/1324", 50),
            (expectedURL, "bytes 0-99/1324", 99)
        ] {
            do {
                _ = try PackRangeResponseValidator.validate(
                    statusCode: 206,
                    responseURL: mutation.0,
                    expectedURL: expectedURL,
                    etag: "fixed",
                    contentRange: mutation.1,
                    bodyBytes: mutation.2,
                    requestedStart: 0,
                    requestedEndExclusive: 100
                )
                throw NSError(domain: "PackInspectorHarness", code: 7)
            } catch let error as NSError where error.domain == "PackInspectorHarness" {
                throw error
            } catch {}
        }
        try requireFailure(.capabilityExpired) {
            _ = try PackDownloadFlow.execute(
                request(valid),
                beforeTransport: {},
                transport: SpyTransport(response: try response(status: 400, url: valid, body: Data("safe".utf8)))
            )
        }
        try requireFailure(.rejected) {
            _ = try PackDownloadFlow.execute(
                request(valid),
                beforeTransport: {},
                transport: SpyTransport(response: try response(status: 403, url: valid, body: Data("policy".utf8)))
            )
        }
        try requireFailure(.rangeNotSatisfiable) {
            _ = try PackDownloadFlow.execute(
                request(valid),
                beforeTransport: {},
                transport: SpyTransport(response: try response(status: 416, url: valid, body: Data()))
            )
        }
        try requireFailure(.rejected) {
            _ = try PackDownloadFlow.execute(
                request(valid),
                beforeTransport: {},
                transport: SpyTransport(response: try response(status: 416, url: valid, body: Data("x".utf8)))
            )
        }
        try requireFailure(.rejected) {
            _ = try PackDownloadFlow.execute(
                request(valid),
                beforeTransport: {},
                transport: SpyTransport(response: try response(status: 500, url: valid, body: Data()))
            )
        }
        try runInstallReplayMatrix()
    }

    private static func request(_ capabilityURL: String) -> PackDownloadRequest {
        PackDownloadRequest(
            capabilityURL: capabilityURL,
            packId: "b3-sandbox-proof",
            version: "1.0.0-b3.1",
            archiveName: "b3-sandbox-proof.zip",
            startByte: 0,
            endByteExclusive: 100,
            truncate: false
        )
    }

    private static func response(
        status: Int,
        url: String,
        body: Data = Data(repeating: 1, count: 100)
    ) throws -> DownloadResponse {
        guard let responseURL = URL(string: url),
              let response = HTTPURLResponse(
                url: responseURL,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: status == 206
                    ? ["ETag": "fixed", "Content-Range": "bytes 0-99/1324"]
                    : [:]
              ) else { throw NSError(domain: "PackInspectorHarness", code: 9) }
        return DownloadResponse(data: body, response: response)
    }

    private static func requireFailure(
        _ expected: PackTransferError,
        operation: () throws -> Void
    ) throws {
        do {
            try operation()
            throw NSError(domain: "PackInspectorHarness", code: 10)
        } catch let error as PackTransferError {
            guard error == expected else { throw NSError(domain: "PackInspectorHarness", code: 11) }
        }
    }

    private static func runInstallReplayMatrix() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? fileManager.removeItem(at: root) }
        try fileManager.createDirectory(at: root, withIntermediateDirectories: false)
        let marker = ActivationMarker(
            manifestSha256: String(repeating: "a", count: 64),
            packId: "b3-sandbox-proof",
            version: "1.0.0-b3.1"
        )
        let markerData = try PackInstallSealer.encodedMarker(marker)
        let evidence = PackSealEvidence(
            installedPathToken: "installed/b3-sandbox-proof/1.0.0-b3.1",
            activationMarkerSha256: String(repeating: "b", count: 64)
        )

        let first = root.appendingPathComponent("first")
        let firstStaging = first.appendingPathComponent("staging")
        let firstInstalled = first.appendingPathComponent("installed")
        try fileManager.createDirectory(at: firstStaging, withIntermediateDirectories: true)
        try markerData.write(to: firstStaging.appendingPathComponent("activation.json"))
        let firstResult = try PackInstallSealer.seal(
            staging: firstStaging,
            installed: firstInstalled,
            marker: marker,
            evidence: evidence,
            validateStaging: {}
        )
        guard firstResult == evidence, fileManager.fileExists(atPath: firstInstalled.path) else {
            throw NSError(domain: "PackInspectorHarness", code: 12)
        }

        var replayValidatedStaging = false
        let replayResult = try PackInstallSealer.seal(
            staging: firstStaging,
            installed: firstInstalled,
            marker: marker,
            evidence: evidence,
            validateStaging: { replayValidatedStaging = true }
        )
        guard replayResult == evidence, !replayValidatedStaging else {
            throw NSError(domain: "PackInspectorHarness", code: 13)
        }

        let mismatch = ActivationMarker(
            manifestSha256: String(repeating: "c", count: 64),
            packId: marker.packId,
            version: marker.version
        )
        try PackInstallSealer.encodedMarker(mismatch).write(
            to: firstInstalled.appendingPathComponent("activation.json"),
            options: .atomic
        )
        try requireFailure(.rejected) {
            _ = try PackInstallSealer.seal(
                staging: firstStaging,
                installed: firstInstalled,
                marker: marker,
                evidence: evidence,
                validateStaging: {}
            )
        }

        let hostile = root.appendingPathComponent("hostile")
        let hostileStaging = hostile.appendingPathComponent("staging")
        try fileManager.createDirectory(at: hostileStaging, withIntermediateDirectories: true)
        try fileManager.createSymbolicLink(
            at: hostileStaging.appendingPathComponent("activation.json"),
            withDestinationURL: firstInstalled.appendingPathComponent("activation.json")
        )
        try requireFailure(.rejected) {
            _ = try PackInstallSealer.seal(
                staging: hostileStaging,
                installed: hostile.appendingPathComponent("installed"),
                marker: marker,
                evidence: evidence,
                validateStaging: {}
            )
        }

        let nonRegular = root.appendingPathComponent("non-regular")
        let nonRegularStaging = nonRegular.appendingPathComponent("staging")
        try fileManager.createDirectory(
            at: nonRegularStaging.appendingPathComponent("activation.json"),
            withIntermediateDirectories: true
        )
        try requireFailure(.rejected) {
            _ = try PackInstallSealer.seal(
                staging: nonRegularStaging,
                installed: nonRegular.appendingPathComponent("installed"),
                marker: marker,
                evidence: evidence,
                validateStaging: {}
            )
        }

        let nonCanonical = root.appendingPathComponent("non-canonical")
        let nonCanonicalStaging = nonCanonical.appendingPathComponent("staging")
        try fileManager.createDirectory(at: nonCanonicalStaging, withIntermediateDirectories: true)
        try Data(markerData.dropLast()).write(
            to: nonCanonicalStaging.appendingPathComponent("activation.json")
        )
        try requireFailure(.rejected) {
            _ = try PackInstallSealer.seal(
                staging: nonCanonicalStaging,
                installed: nonCanonical.appendingPathComponent("installed"),
                marker: marker,
                evidence: evidence,
                validateStaging: {}
            )
        }
    }
}

private final class SpyTransport: PackDownloadTransport {
    private(set) var calls = 0
    private(set) var requests: [URLRequest] = []
    private let response: DownloadResponse

    init(response: DownloadResponse) { self.response = response }

    func fetch(_ request: URLRequest) throws -> DownloadResponse {
        calls += 1
        requests.append(request)
        return response
    }
}

private struct SignedEnvelopeFixture: Decodable {
    let canonicalManifestBase64: String
}
