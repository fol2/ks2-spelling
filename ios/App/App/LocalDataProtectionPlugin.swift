import Capacitor
import Foundation

@objc(LocalDataProtectionPlugin)
public final class LocalDataProtectionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalDataProtectionPlugin"
    public let jsName = "LocalDataProtection"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(
            name: "applyDatabasePolicy",
            returnType: CAPPluginReturnPromise
        )
    ]

    @objc public func applyDatabasePolicy(_ call: CAPPluginCall) {
        guard requireKeys(call, exactly: ["databaseName"]),
              call.getString("databaseName") == "ks2-spelling" else {
            reject(call)
            return
        }
        do {
            let fileManager = FileManager.default
            let library = try fileManager.url(
                for: .libraryDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            ).standardizedFileURL
            let root = library
                .appendingPathComponent(
                    "CapacitorDatabase",
                    isDirectory: true
                )
                .standardizedFileURL
            guard root.deletingLastPathComponent() == library else {
                throw LocalDataProtectionError.invalid
            }
            try fileManager.createDirectory(
                at: root,
                withIntermediateDirectories: true,
                attributes: [
                    .protectionKey: FileProtectionType.complete
                ]
            )

            var backupValues = URLResourceValues()
            backupValues.isExcludedFromBackup = true
            var mutableRoot = root
            try mutableRoot.setResourceValues(backupValues)
            try protect(root, using: fileManager)

            var enumerationFailed = false
            guard let enumerator = fileManager.enumerator(
                at: root,
                includingPropertiesForKeys: [.isSymbolicLinkKey],
                options: [],
                errorHandler: { _, _ in
                    enumerationFailed = true
                    return false
                }
            ) else {
                throw LocalDataProtectionError.invalid
            }
            for case let item as URL in enumerator {
                try protect(item, using: fileManager)
            }
            guard !enumerationFailed,
                  try root.resourceValues(
                    forKeys: [.isExcludedFromBackupKey]
                  ).isExcludedFromBackup == true else {
                throw LocalDataProtectionError.invalid
            }
            call.resolve([
                "automaticBackupDisabled": true,
                "platformProtection": platformProtection
            ])
        } catch {
            reject(call, underlying: error)
        }
    }

    private func protect(
        _ item: URL,
        using fileManager: FileManager
    ) throws {
        let values = try item.resourceValues(
            forKeys: [.isSymbolicLinkKey]
        )
        guard values.isSymbolicLink != true else {
            throw LocalDataProtectionError.invalid
        }
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: item.path
        )
        let attributes = try fileManager.attributesOfItem(
            atPath: item.path
        )
        guard protectionIsVerified(
            attributes[.protectionKey] as? FileProtectionType
        ) else {
            throw LocalDataProtectionError.invalid
        }
    }

    private var platformProtection: String {
        #if targetEnvironment(simulator)
        return "ios-simulator-protection-unobservable"
        #else
        return "ios-complete"
        #endif
    }

    private func protectionIsVerified(
        _ actual: FileProtectionType?
    ) -> Bool {
        #if targetEnvironment(simulator)
        return actual == nil ||
            actual == FileProtectionType.complete ||
            actual == FileProtectionType.completeUntilFirstUserAuthentication
        #else
        return actual == FileProtectionType.complete
        #endif
    }

    private func requireKeys(
        _ call: CAPPluginCall,
        exactly expected: Set<String>
    ) -> Bool {
        let keys = Set(call.options.keys.compactMap { $0 as? String })
        return keys == expected && call.options.keys.count == keys.count
    }

    private func reject(
        _ call: CAPPluginCall,
        underlying: Error? = nil
    ) {
        call.reject(
            "Local data protection could not be verified.",
            "LOCAL_DATA_PROTECTION_REJECTED",
            underlying
        )
    }
}

private enum LocalDataProtectionError: Error {
    case invalid
}
