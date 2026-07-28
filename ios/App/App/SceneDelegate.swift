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

    private func configureNativeTextInput(
        for bridgeViewController: CAPBridgeViewController
    ) {
        guard let webView = bridgeViewController.webView else {
            return
        }

        // Capacitor 8.4.1 installs a process-wide WKContentView focus swizzle and
        // then marks this WebView as if every focus were user initiated. On iOS
        // 27 that can leave a genuinely tapped HTML input focused with only the
        // assistant bar visible, while the software keyboard appears much later.
        // Clearing the per-WebView override makes the installed bridge pass
        // WebKit's real user-interaction value through unchanged.
        webView.capacitor.setKeyboardShouldRequireUserInteraction(nil)

        // Use UIKit's public input-assistant API rather than reintroducing the
        // Capacitor Keyboard plugin or another WKContentView swizzle. The app has
        // no previous/next form workflow worth spending vertical space on.
        let assistantItem = webView.inputAssistantItem
        assistantItem.leadingBarButtonGroups = []
        assistantItem.trailingBarButtonGroups = []
        assistantItem.allowsHidingShortcuts = true
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
        configureNativeTextInput(for: bridgeViewController)

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
