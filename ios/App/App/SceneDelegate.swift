import UIKit
import WebKit
import Capacitor

/// First-paint policy for the product WKWebView.
///
/// Capacitor 8.4.1 creates the web view at `.zero` and, on WebContent death,
/// calls `webView.reload()`. `reload()` is a no-op when the first navigation
/// never committed (`url == nil` / `about:blank`), and during that hang the
/// handler also leaves `isOpaque = false`, so the window shows black behind a
/// live native process. Terminate-and-relaunch starts a new web view; this
/// policy recovers in-process instead. See issue 185.
enum WebViewFirstPaintPolicy {
    static let uncommittedRecoveryDelay: TimeInterval = 2

    static func initialFrame(requested: CGRect, screenBounds: CGRect) -> CGRect {
        if requested.width >= 1, requested.height >= 1 {
            return requested
        }
        return screenBounds
    }

    static func needsStartURLLoad(currentURL: URL?) -> Bool {
        guard let currentURL else {
            return true
        }
        let value = currentURL.absoluteString
        return value.isEmpty || value == "about:blank"
    }
}

final class ProductBridgeViewController: CAPBridgeViewController {
    private var uncommittedFirstPaintRecoveryScheduled = false

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        // The product does not make the whole web view first responder at launch.
        // Learners open nickname, search and PIN through real taps. Practice may
        // later call input.focus() on its visible field after Set off.
        descriptor.hasInitialFocus = false
        return descriptor
    }

    override func webView(
        with frame: CGRect,
        configuration: WKWebViewConfiguration
    ) -> WKWebView {
        WKWebView(
            frame: WebViewFirstPaintPolicy.initialFrame(
                requested: frame,
                screenBounds: UIScreen.main.bounds
            ),
            configuration: configuration
        )
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Keep Capacitor Core's default: programmatic input.focus() may raise the
        // software keyboard. Practice uses that after Set off, Hear it again and
        // the next card. Launch-time WebView first-responder ownership stays off
        // via hasInitialFocus = false above — that was the iOS 27 breakage, not
        // this per-focus flag.
        webView?.capacitor.setKeyboardShouldRequireUserInteraction(false)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Capacitor sets isOpaque = false until didFinish so a white default
        // cannot flash. If navigation never finishes, that hang is a black hole
        // through to an unset window. Restore opacity immediately; the loading
        // shell is the first authored paint.
        webView?.isOpaque = true
        webView?.backgroundColor = .systemBackground
        webView?.scrollView.backgroundColor = .systemBackground
        scheduleUncommittedFirstPaintRecovery()
    }

    private func scheduleUncommittedFirstPaintRecovery() {
        guard !uncommittedFirstPaintRecoveryScheduled else {
            return
        }
        uncommittedFirstPaintRecoveryScheduled = true
        DispatchQueue.main.asyncAfter(
            deadline: .now() + WebViewFirstPaintPolicy.uncommittedRecoveryDelay
        ) { [weak self] in
            self?.recoverUncommittedFirstPaint()
        }
    }

    func recoverUncommittedFirstPaint() {
        guard WebViewFirstPaintPolicy.needsStartURLLoad(currentURL: webView?.url) else {
            return
        }
        // loadWebView() re-issues the start URL. reload() cannot: with a nil
        // URL it is a documented no-op, which is the hang observed on the
        // floor iPad after install-over.
        loadWebView()
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
        window?.backgroundColor = .systemBackground
        guard scene is UIWindowScene,
              let bridgeViewController = window?.rootViewController as? CAPBridgeViewController else {
            return
        }
        bridgeViewController.loadViewIfNeeded()
        if !isOfflineB4Bundle() {
            bridgeViewController.bridge?.registerPluginInstance(ParentAccessPlugin())
            bridgeViewController.bridge?.registerPluginInstance(LocalDataProtectionPlugin())
            bridgeViewController.bridge?.registerPluginInstance(InstalledAudioPlugin())
            bridgeViewController.bridge?.registerPluginInstance(PackTransferPlugin())
            bridgeViewController.bridge?.registerPluginInstance(CommercePlugin())
        }
        #if B3_SANDBOX_PROOF
        bridgeViewController.bridge?.registerPluginInstance(BuildAuthorityPlugin())
        bridgeViewController.bridge?.registerPluginInstance(B3ProofObservationPlugin())
        #endif
    }
}
