import Capacitor
import Foundation
import UIKit

#if B3_SANDBOX_PROOF
@objc(BuildAuthorityPlugin)
public final class BuildAuthorityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BuildAuthorityPlugin"
    public let jsName = "BuildAuthority"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getAuthority", returnType: CAPPluginReturnPromise)
    ]

    private func authority() -> [String: Any]? {
        let dictionary = Bundle.main.infoDictionary ?? [:]
        let commit = dictionary["B3TestedApplicationCommit"] as? String ?? ""
        let fingerprint = dictionary["B3ApplicationFingerprint"] as? String ?? ""
        let versionName = dictionary["CFBundleShortVersionString"] as? String ?? ""
        let buildNumber = dictionary["CFBundleVersion"] as? String ?? ""
        guard commit.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              fingerprint.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              versionName == "0.3.0-b3",
              buildNumber.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil else {
            return nil
        }
        return [
            "mode": "B3SandboxProof",
            "proofKind": "physical-live",
            "platform": "ios",
            "distribution": "development",
            "publicSandboxOrigin": "https://b3-gateway.eugnel.uk",
            "workerName": "ks2-spelling-b3-sandbox",
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "testedApplicationCommit": commit,
            "applicationFingerprint": fingerprint,
            "versionName": versionName,
            "buildNumber": buildNumber
        ]
    }

    private func persistAuthority() {
        guard let value = authority(),
              let applicationSupport = FileManager.default.urls(
                  for: .applicationSupportDirectory,
                  in: .userDomainMask
              ).first else { return }
        do {
            try FileManager.default.createDirectory(
                at: applicationSupport,
                withIntermediateDirectories: true
            )
            let bytes = try JSONSerialization.data(
                withJSONObject: value,
                options: [.sortedKeys]
            )
            try bytes.write(
                to: applicationSupport.appendingPathComponent("b3-build-authority.json"),
                options: [.atomic, .completeFileProtection]
            )
            let receiptCopy = applicationSupport.appendingPathComponent("b3-sandbox-receipt")
            guard let receipt = Bundle.main.appStoreReceiptURL,
                  receipt.lastPathComponent == "sandboxReceipt",
                  FileManager.default.fileExists(atPath: receipt.path) else {
                try? FileManager.default.removeItem(at: receiptCopy)
                return
            }
            try Data(contentsOf: receipt).write(
                to: receiptCopy,
                options: [.atomic, .completeFileProtection]
            )
        } catch {
            // Verification fails closed when the read-only device inspector cannot obtain this file.
        }
    }

    public override func load() {
        persistAuthority()
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.persistAuthority()
        }
    }

    @objc func getAuthority(_ call: CAPPluginCall) {
        guard let value = authority() else {
            call.reject("BUILD_AUTHORITY_INVALID")
            return
        }
        persistAuthority()
        call.resolve(value)
    }
}
#endif
