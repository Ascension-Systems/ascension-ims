import UIKit
import Capacitor

/// The native ground behind the WebView. A DYNAMIC colour so the iOS rubber-band overscroll
/// gutter follows light/dark instead of being a fixed light paper (which showed as white behind
/// dark mode). Values match the CSS --paper token: light #fbfaf7, dark #14120f.
private let paperBackground = UIColor { traits in
    traits.userInterfaceStyle == .dark
        ? UIColor(red: 0x14 / 255.0, green: 0x12 / 255.0, blue: 0x0f / 255.0, alpha: 1)
        : UIColor(red: 0xfb / 255.0, green: 0xfa / 255.0, blue: 0xf7 / 255.0, alpha: 1)
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.backgroundColor = paperBackground
        window?.rootViewController?.view.backgroundColor = paperBackground
        window?.makeKeyAndVisible()

        // Make the WebView transparent so the overscroll gutter shows the dynamic native ground
        // above (which follows light/dark) rather than a fixed WebView background. The page's own
        // html/body are opaque (--paper), so only the empty rubber-band area is affected.
        DispatchQueue.main.async {
            if let bridge = self.window?.rootViewController as? CAPBridgeViewController,
               let webView = bridge.webView {
                webView.isOpaque = false
                webView.backgroundColor = .clear
                webView.scrollView.backgroundColor = .clear
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
