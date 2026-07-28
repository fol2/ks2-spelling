import UIKit
import WebKit
import Capacitor

private final class ProductWebView: WKWebView {
    override var inputAssistantItem: UITextInputAssistantItem {
        let item = super.inputAssistantItem
        item.leadingBarButtonGroups = []
        item.trailingBarButtonGroups = []
        item.allowsHidingShortcuts = true
        return item
    }
}

@objc(ProductBridgeViewController)
final class ProductBridgeViewController: CAPBridgeViewController {
    private var releasedInitialWebViewFocus = false

    override func webView(
        with frame: CGRect,
        configuration: WKWebViewConfiguration
    ) -> WKWebView {
        ProductWebView(frame: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()

        // Capacitor 8.4.1 installs a process-wide WKContentView focus swizzle
        // and marks each WebView as though every focus were user initiated.
        // On iOS 27 that can leave a tapped HTML input focused with only the
        // assistant bar visible while the software keyboard arrives much later.
        // Nil makes the installed bridge pass WebKit's real interaction value.
        webView?.capacitor.setKeyboardShouldRequireUserInteraction(nil)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)

        // CAPBridgeViewController gives the whole WebView initial responder
        // status. Release that container-level focus once so the first real
        // HTML-field tap owns the input session immediately.
        guard !releasedInitialWebViewFocus else {
            return
        }
        releasedInitialWebViewFocus = true
        _ = webView?.resignFirstResponder()
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
