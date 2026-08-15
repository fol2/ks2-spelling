import Capacitor
import Foundation
import LocalAuthentication

@objc(ParentAccessPlugin)
public final class ParentAccessPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ParentAccessPlugin"
    public let jsName = "ParentAccess"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(
            name: "getBiometricAvailability",
            returnType: CAPPluginReturnPromise
        ),
        CAPPluginMethod(
            name: "authenticateBiometric",
            returnType: CAPPluginReturnPromise
        ),
        CAPPluginMethod(
            name: "getDeviceOwnerAuthenticationAvailability",
            returnType: CAPPluginReturnPromise
        ),
        CAPPluginMethod(
            name: "authenticateDeviceOwner",
            returnType: CAPPluginReturnPromise
        )
    ]

    // Both native routes are one authority surface. A quick-unlock prompt and
    // a PIN bootstrap/recovery prompt may never overlap and race two calls.
    private var activeContext: LAContext?

    @objc public func getBiometricAvailability(_ call: CAPPluginCall) {
        guard call.options.keys.isEmpty else {
            rejectBiometric(call)
            return
        }
        let context = LAContext()
        var evaluationError: NSError?
        let available = context.canEvaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            error: &evaluationError
        )
        let type: String
        if available && context.biometryType == .faceID {
            type = "face"
        } else if available && context.biometryType == .touchID {
            type = "fingerprint"
        } else {
            type = "none"
        }
        call.resolve([
            "available": available && type != "none",
            "type": type
        ])
    }

    @objc public func authenticateBiometric(_ call: CAPPluginCall) {
        guard let reason = requireReason(call) else {
            rejectBiometric(call)
            return
        }
        DispatchQueue.main.async {
            guard self.activeContext == nil else {
                self.rejectBiometric(call)
                return
            }
            let context = LAContext()
            var evaluationError: NSError?
            guard context.canEvaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                error: &evaluationError
            ) else {
                self.rejectBiometric(call)
                return
            }
            self.activeContext = context
            context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason
            ) { success, _ in
                DispatchQueue.main.async {
                    guard self.activeContext === context else {
                        self.rejectBiometric(call)
                        return
                    }
                    self.activeContext = nil
                    if success {
                        call.resolve(["authenticated": true])
                    } else {
                        self.rejectBiometric(call)
                    }
                }
            }
        }
    }

    @objc public func getDeviceOwnerAuthenticationAvailability(
        _ call: CAPPluginCall
    ) {
        guard call.options.keys.isEmpty else {
            rejectDeviceOwner(call)
            return
        }
        let context = LAContext()
        var evaluationError: NSError?
        let available = context.canEvaluatePolicy(
            .deviceOwnerAuthentication,
            error: &evaluationError
        )
        call.resolve(["available": available])
    }

    @objc public func authenticateDeviceOwner(_ call: CAPPluginCall) {
        guard let reason = requireReason(call) else {
            rejectDeviceOwner(call)
            return
        }
        DispatchQueue.main.async {
            guard self.activeContext == nil else {
                self.rejectDeviceOwner(call)
                return
            }
            let context = LAContext()
            var evaluationError: NSError?
            guard context.canEvaluatePolicy(
                .deviceOwnerAuthentication,
                error: &evaluationError
            ) else {
                self.rejectDeviceOwner(call)
                return
            }
            self.activeContext = context
            context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: reason
            ) { success, _ in
                DispatchQueue.main.async {
                    guard self.activeContext === context else {
                        self.rejectDeviceOwner(call)
                        return
                    }
                    self.activeContext = nil
                    if success {
                        call.resolve(["authenticated": true])
                    } else {
                        self.rejectDeviceOwner(call)
                    }
                }
            }
        }
    }

    private func requireReason(_ call: CAPPluginCall) -> String? {
        guard requireKeys(call, exactly: ["reason"]),
              let reason = call.getString("reason"),
              let length = reason.data(using: .utf8)?.count,
              length > 0,
              length <= 120 else {
            return nil
        }
        return reason
    }

    private func requireKeys(
        _ call: CAPPluginCall,
        exactly expected: Set<String>
    ) -> Bool {
        let keys = Set(call.options.keys.compactMap { $0 as? String })
        return keys == expected && call.options.keys.count == keys.count
    }

    private func rejectBiometric(_ call: CAPPluginCall) {
        call.reject(
            "Parent biometric authentication rejected.",
            "PARENT_BIOMETRICS_REJECTED"
        )
    }

    private func rejectDeviceOwner(_ call: CAPPluginCall) {
        call.reject(
            "Parent device-owner authentication rejected.",
            "PARENT_DEVICE_AUTHENTICATION_REJECTED"
        )
    }
}
