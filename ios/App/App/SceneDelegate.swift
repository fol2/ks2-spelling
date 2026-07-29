import UIKit
import Capacitor

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

    private func restoreUserDrivenKeyboardFocus(
        on bridgeViewController: CAPBridgeViewController
    ) {
        // Capacitor Core normally marks this web view as not requiring a user
        // interaction before keyboard presentation. That is useful for apps that
        // call input.focus() programmatically.
        //
        // KS2 Spelling deliberately does not do that: each visible HTML field is
        // tapped by the learner. Clearing the per-web-view override makes the
        // runtime preserve WebKit's real user-interaction value instead of forcing
        // it. Together with ios.initialFocus=false, this avoids creating a stale
        // first-responder session before any visible field has been touched.
        bridgeViewController.webView?.capacitor
            .setKeyboardShouldRequireUserInteraction(nil)
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
        restoreUserDrivenKeyboardFocus(on: bridgeViewController)
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
