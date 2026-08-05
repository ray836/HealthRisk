import UIKit

@MainActor
enum AppOrientation {
    private(set) static var supportedOrientations: UIInterfaceOrientationMask = .allButUpsideDown

    static func enterGameplay() {
        updateSupportedOrientations(.landscape)
    }

    static func leaveGameplay() {
        updateSupportedOrientations(.allButUpsideDown)
    }

    private static func updateSupportedOrientations(_ orientations: UIInterfaceOrientationMask) {
        supportedOrientations = orientations

        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes
        where scene.activationState != .unattached {
            scene.windows.forEach {
                $0.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            }
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientations)) { _ in }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        AppOrientation.supportedOrientations
    }
}
