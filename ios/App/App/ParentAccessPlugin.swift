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
        )
    ]

    private var activeContext: LAContext?

    @objc public func getBiometricAvailability(_ call: CAPPluginCall) {
        guard call.options.keys.isEmpty else {
            reject(call)
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
        guard requireKeys(call, exactly: ["reason"]),
              let reason = call.getString("reason"),
              let length = reason.data(using: .utf8)?.count,
              length > 0,
              length <= 120 else {
            reject(call)
            return
        }
        DispatchQueue.main.async {
            guard self.activeContext == nil else {
                self.reject(call)
                return
            }
            let context = LAContext()
            var evaluationError: NSError?
            guard context.canEvaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                error: &evaluationError
            ) else {
                self.reject(call)
                return
            }
            self.activeContext = context
            context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason
            ) { success, _ in
                DispatchQueue.main.async {
                    guard self.activeContext === context else {
                        self.reject(call)
                        return
                    }
                    self.activeContext = nil
                    if success {
                        call.resolve(["authenticated": true])
                    } else {
                        self.reject(call)
                    }
                }
            }
        }
    }

    private func requireKeys(
        _ call: CAPPluginCall,
        exactly expected: Set<String>
    ) -> Bool {
        let keys = Set(call.options.keys.compactMap { $0 as? String })
        return keys == expected && call.options.keys.count == keys.count
    }

    private func reject(_ call: CAPPluginCall) {
        call.reject(
            "Parent biometric authentication rejected.",
            "PARENT_BIOMETRICS_REJECTED"
        )
    }
}
