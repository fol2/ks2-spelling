import Capacitor
import CryptoKit
import Foundation
import UniformTypeIdentifiers
import UIKit

@objc(LearningBackupFilePlugin)
public final class LearningBackupFilePlugin:
    CAPPlugin,
    CAPBridgedPlugin,
    UIDocumentPickerDelegate {
    public let identifier = "LearningBackupFilePlugin"
    public let jsName = "LearningBackupFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "presentExport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickImport", returnType: CAPPluginReturnPromise)
    ]

    private let maximumBytes = 5 * 1024 * 1024
    private var activeExportController: UIActivityViewController?
    private var pendingImportCall: CAPPluginCall?

    @objc public func presentExport(_ call: CAPPluginCall) {
        guard requireKeys(
            call,
            exactly: ["fileName", "bytesBase64", "sha256"]
        ), let fileName = call.getString("fileName"),
           isSafeFileName(fileName),
           let bytesBase64 = call.getString("bytesBase64"),
           let bytes = Data(base64Encoded: bytesBase64),
           bytes.count >= 2,
           bytes.count <= maximumBytes,
           bytes.base64EncodedString() == bytesBase64,
           let expectedHash = call.getString("sha256"),
           isLowercaseSHA256(expectedHash),
           constantTimeEqual(sha256(bytes), expectedHash) else {
            reject(call)
            return
        }

        DispatchQueue.main.async {
            guard self.activeExportController == nil,
                  let presenter = self.bridge?.viewController,
                  presenter.presentedViewController == nil else {
                self.reject(call)
                return
            }
            let directory: URL
            let target: URL
            do {
                let root = FileManager.default.temporaryDirectory
                    .appendingPathComponent(
                        "learning-backups",
                        isDirectory: true
                    )
                try? FileManager.default.removeItem(at: root)
                try FileManager.default.createDirectory(
                    at: root,
                    withIntermediateDirectories: true
                )
                directory = root.appendingPathComponent(
                    UUID().uuidString,
                    isDirectory: true
                )
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: false
                )
                target = directory.appendingPathComponent(
                    fileName,
                    isDirectory: false
                )
                try bytes.write(
                    to: target,
                    options: [.atomic, .completeFileProtection]
                )
            } catch {
                self.reject(call, underlying: error)
                return
            }

            let controller = UIActivityViewController(
                activityItems: [target],
                applicationActivities: nil
            )
            if let popover = controller.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(
                    x: presenter.view.bounds.midX,
                    y: presenter.view.bounds.midY,
                    width: 1,
                    height: 1
                )
            }
            controller.completionWithItemsHandler = {
                [weak self, weak controller] _, _, _, _ in
                try? FileManager.default.removeItem(at: directory)
                if self?.activeExportController === controller {
                    self?.activeExportController = nil
                }
            }
            self.activeExportController = controller
            presenter.present(controller, animated: true) {
                call.resolve(["presented": true])
            }
        }
    }

    @objc public func pickImport(_ call: CAPPluginCall) {
        guard requireKeys(call, exactly: ["maximumBytes"]),
              call.getInt("maximumBytes") == maximumBytes else {
            reject(call)
            return
        }
        DispatchQueue.main.async {
            guard self.pendingImportCall == nil,
                  let presenter = self.bridge?.viewController,
                  presenter.presentedViewController == nil else {
                self.reject(call)
                return
            }
            call.keepAlive = true
            self.pendingImportCall = call
            let picker = UIDocumentPickerViewController(
                forOpeningContentTypes: [UTType.json],
                asCopy: true
            )
            picker.allowsMultipleSelection = false
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    public func documentPickerWasCancelled(
        _ controller: UIDocumentPickerViewController
    ) {
        finishImport { call in
            call.resolve(["cancelled": true])
        }
    }

    public func documentPicker(
        _ controller: UIDocumentPickerViewController,
        didPickDocumentsAt urls: [URL]
    ) {
        guard urls.count == 1, let source = urls.first else {
            finishImport { call in self.reject(call) }
            return
        }
        do {
            let bytes = try readBoundedRegularFile(source)
            finishImport { call in
                call.resolve([
                    "cancelled": false,
                    "bytesBase64": bytes.base64EncodedString(),
                    "sha256": self.sha256(bytes)
                ])
            }
        } catch {
            finishImport { call in
                self.reject(call, underlying: error)
            }
        }
    }

    private func finishImport(_ finish: (CAPPluginCall) -> Void) {
        guard let call = pendingImportCall else {
            return
        }
        pendingImportCall = nil
        call.keepAlive = false
        finish(call)
    }

    private func readBoundedRegularFile(_ source: URL) throws -> Data {
        let values = try source.resourceValues(
            forKeys: [
                .fileSizeKey,
                .isRegularFileKey,
                .isSymbolicLinkKey
            ]
        )
        guard values.isRegularFile == true,
              values.isSymbolicLink != true,
              let fileSize = values.fileSize,
              fileSize >= 2,
              fileSize <= maximumBytes else {
            throw BackupFileError.invalid
        }
        let handle = try FileHandle(forReadingFrom: source)
        defer { try? handle.close() }
        var bytes = Data()
        while bytes.count <= maximumBytes {
            let remaining = maximumBytes + 1 - bytes.count
            guard let chunk = try handle.read(
                upToCount: min(64 * 1024, remaining)
            ), !chunk.isEmpty else {
                break
            }
            bytes.append(chunk)
        }
        guard bytes.count >= 2, bytes.count <= maximumBytes else {
            throw BackupFileError.invalid
        }
        return bytes
    }

    private func isSafeFileName(_ value: String) -> Bool {
        value.range(
            of: #"^ks2-spelling-backup-[0-9]{8}-[0-9]{6}\.json$"#,
            options: .regularExpression
        ) != nil
    }

    private func isLowercaseSHA256(_ value: String) -> Bool {
        value.range(
            of: #"^[0-9a-f]{64}$"#,
            options: .regularExpression
        ) != nil
    }

    private func sha256(_ bytes: Data) -> String {
        SHA256.hash(data: bytes)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private func constantTimeEqual(_ left: String, _ right: String) -> Bool {
        let leftBytes = Array(left.utf8)
        let rightBytes = Array(right.utf8)
        guard leftBytes.count == rightBytes.count else {
            return false
        }
        var difference: UInt8 = 0
        for index in leftBytes.indices {
            difference |= leftBytes[index] ^ rightBytes[index]
        }
        return difference == 0
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
            "Learning backup file operation rejected.",
            "LEARNING_BACKUP_FILE_REJECTED",
            underlying
        )
    }
}

private enum BackupFileError: Error {
    case invalid
}
