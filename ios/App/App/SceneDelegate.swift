import UIKit
import Capacitor

final class ProductBridgeViewController: CAPBridgeViewController {
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        // The product never uses programmatic input focus. Do not make the whole
        // web view first responder before the learner has touched a visible field.
        descriptor.hasInitialFocus = false
        return descriptor
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Capacitor's default per-web-view flag is intended to let input.focus()
        // raise the keyboard. Clearing it preserves WebKit's real tap provenance
        // for this product instead of forcing every focus to look user initiated.
        webView?.capacitor.setKeyboardShouldRequireUserInteraction(nil)
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    private func isOfflineB4Bundle() -> Bool {
        guard let url = Bundle.main.url(
            forResource: "index",
            withExtension: "html",
            subdirectory: "public"
        ), let source = try? String(contentsOf: url, encoding: .utf8) else {
            return false
        }
        return source.contains("name=\"ks2-spelling-build-mode\"") &&
            source.contains("content=\"B4Development\"")
    }

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard scene is UIWindowScene,
              let bridgeViewController = window?.rootViewController as? CAPBridgeViewController else {
            return
        }
        bridgeViewController.loadViewIfNeeded()
        if !isOfflineB4Bundle() {
            bridgeViewController.bridge?.registerPluginInstance(ParentAccessPlugin())
            bridgeViewController.bridge?.registerPluginInstance(LocalDataProtectionPlugin())
            bridgeViewController.bridge?.registerPluginInstance(InstalledAudioPlugin())
            bridgeViewController.bridge?.registerPluginInstance(LearningBackupFilePlugin())
            bridgeViewController.bridge?.registerPluginInstance(PackTransferPlugin())
            bridgeViewController.bridge?.registerPluginInstance(CommercePlugin())
        }
        #if B3_SANDBOX_PROOF
        bridgeViewController.bridge?.registerPluginInstance(BuildAuthorityPlugin())
        bridgeViewController.bridge?.registerPluginInstance(B3ProofObservationPlugin())
        #endif
    }
}
