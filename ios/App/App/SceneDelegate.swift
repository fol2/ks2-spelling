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

        // Capacitor 8.4.1 marks every WKWebView focus as user-initiated through
        // a private WKContentView method swizzle. On iOS 27 that can leave a
        // genuinely tapped HTML input focused with only the form accessory bar
        // visible and no software keyboard. Removing the per-WebView override
        // makes the installed swizzle pass WebKit's real user-interaction value
        // through unchanged. Direct taps still open the keyboard; delayed
        // programmatic focus no longer pretends to be a trusted activation.
        bridgeViewController.webView?.capacitor.setKeyboardShouldRequireUserInteraction(nil)

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
