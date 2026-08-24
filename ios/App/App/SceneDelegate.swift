import UIKit
import Capacitor
import WebKit

/// The native ground behind the WebView. A DYNAMIC colour so the iOS rubber-band overscroll
/// gutter follows light/dark. Values match the CSS --paper token: light #fbfaf7, dark #14120f.
/// Which style resolves is driven by the window's overrideUserInterfaceStyle, which ThemeBridge
/// sets from the in-app theme toggle — so the gutter follows the CHOSEN theme, not just the OS.
private let paperBackground = UIColor { traits in
    traits.userInterfaceStyle == .dark
        ? UIColor(red: 0x14 / 255.0, green: 0x12 / 255.0, blue: 0x0f / 255.0, alpha: 1)
        : UIColor(red: 0xfb / 255.0, green: 0xfa / 255.0, blue: 0xf7 / 255.0, alpha: 1)
}

/// Receives 'light'/'dark' from the web app (window.webkit.messageHandlers.theme) whenever the
/// in-app toggle changes or the page loads, and forces the window's interface style to match.
/// That re-resolves paperBackground, so the overscroll gutter tracks the in-app choice exactly.
final class ThemeBridge: NSObject, WKScriptMessageHandler {
    weak var window: UIWindow?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let theme = message.body as? String else { return }
        DispatchQueue.main.async {
            self.window?.overrideUserInterfaceStyle = (theme == "dark") ? .dark : .light
        }
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let themeBridge = ThemeBridge()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.backgroundColor = paperBackground
        window?.rootViewController?.view.backgroundColor = paperBackground
        window?.makeKeyAndVisible()

        // Paint the WebView and its scroll view with the dynamic paper colour DIRECTLY (opaque).
        // The iOS rubber-band overscroll gutter is drawn with the scroll view's backgroundColor,
        // so this makes the gutter follow light/dark. It is deliberately NOT transparent — a
        // clear WebView let the black window/base layer show through on overscroll.
        DispatchQueue.main.async {
            if let bridge = self.window?.rootViewController as? CAPBridgeViewController,
               let webView = bridge.webView {
                webView.isOpaque = true
                webView.backgroundColor = paperBackground
                webView.scrollView.backgroundColor = paperBackground
                // Listen for theme changes posted by the web app.
                self.themeBridge.window = self.window
                webView.configuration.userContentController.add(self.themeBridge, name: "theme")
            }
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
