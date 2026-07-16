import Capacitor
import Foundation

#if B3_SANDBOX_PROOF
@objc(B3ProofObservationPlugin)
public final class B3ProofObservationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "B3ProofObservationPlugin"
    public let jsName = "B3ProofObservation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getLaunchCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishObservation", returnType: CAPPluginReturnPromise)
    ]

    private static let commandArgument = "--b3-proof-command-v1"
    private static let observationFilename = "b3-proof-observation-v1.json"
    private static let maximumBytes = 64 * 1024
    private static let observationKeys: Set<String> = [
        "schemaVersion", "platform", "buildAuthoritySha256", "captureId",
        "installationId", "sequence", "previousObservationSha256", "scenarioIndex",
        "scenario", "phase", "nextActionCode", "completedTransitions",
        "proofProjection", "observedAt", "observationSha256"
    ]

    @objc public func getLaunchCommand(_ call: CAPPluginCall) {
        guard call.options.isEmpty else {
            reject(call)
            return
        }
        let arguments = ProcessInfo.processInfo.arguments
        let positions = arguments.indices.filter {
            arguments[$0] == Self.commandArgument
        }
        guard positions.count <= 1 else {
            reject(call)
            return
        }
        guard let position = positions.first else {
            call.resolve(["commandJson": NSNull()])
            return
        }
        let valueIndex = arguments.index(after: position)
        guard valueIndex < arguments.endIndex,
              arguments[valueIndex] != Self.commandArgument,
              let bytes = arguments[valueIndex].data(using: .utf8),
              !bytes.isEmpty,
              bytes.count <= Self.maximumBytes else {
            reject(call)
            return
        }
        call.resolve(["commandJson": arguments[valueIndex]])
    }

    @objc public func publishObservation(_ call: CAPPluginCall) {
        do {
            try requireKeys(call, exactly: ["canonicalJson"])
            guard let canonicalJson = call.getString("canonicalJson"),
                  let bytes = canonicalJson.data(using: .utf8),
                  !bytes.isEmpty,
                  bytes.count <= Self.maximumBytes else {
                throw ProofTransportError.rejected
            }
            try validateClosedObservation(bytes)
            let destination = try observationURL()
            try assertSafeTarget(destination)
            try bytes.write(
                to: destination,
                options: [.atomic, .completeFileProtection]
            )
            try assertSafeTarget(destination, mustExist: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableDestination = destination
            try mutableDestination.setResourceValues(values)
            call.resolve(["written": true])
        } catch {
            reject(call)
        }
    }

    private func observationURL() throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let values = try support.resourceValues(
            forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
        )
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw ProofTransportError.rejected
        }
        var backupValues = URLResourceValues()
        backupValues.isExcludedFromBackup = true
        var mutableSupport = support
        try mutableSupport.setResourceValues(backupValues)
        return support.appendingPathComponent(Self.observationFilename, isDirectory: false)
    }

    private func assertSafeTarget(_ target: URL, mustExist: Bool = false) throws {
        guard target.lastPathComponent == Self.observationFilename else {
            throw ProofTransportError.rejected
        }
        if !FileManager.default.fileExists(atPath: target.path) {
            if mustExist { throw ProofTransportError.rejected }
            return
        }
        let values = try target.resourceValues(
            forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        )
        guard values.isRegularFile == true,
              values.isSymbolicLink != true,
              let size = values.fileSize,
              size > 0,
              size <= Self.maximumBytes else {
            throw ProofTransportError.rejected
        }
    }

    private func validateClosedObservation(_ bytes: Data) throws {
        let value = try JSONSerialization.jsonObject(with: bytes)
        guard let object = value as? [String: Any],
              Set(object.keys) == Self.observationKeys,
              object.keys.count == Self.observationKeys.count else {
            throw ProofTransportError.rejected
        }
    }

    private func requireKeys(_ call: CAPPluginCall, exactly expected: Set<String>) throws {
        let keys = Set(call.options.keys.compactMap { $0 as? String })
        guard keys == expected, call.options.keys.count == keys.count else {
            throw ProofTransportError.rejected
        }
    }

    private func reject(_ call: CAPPluginCall) {
        call.reject("Proof observation rejected.", ProofTransportError.rejected.safeCode)
    }
}

private enum ProofTransportError: Error {
    case rejected

    var safeCode: String { "B3_PROOF_OBSERVATION_REJECTED" }
}
#endif
