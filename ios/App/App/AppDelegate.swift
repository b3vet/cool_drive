import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    // Game audio must ignore the ring/silent switch: the default "ambient" session
    // mutes Web Audio (engine/SFX) whenever the switch is on, unless an <audio>
    // element happens to be playing (why sound "needed the radio"). ".playback"
    // pins the session. ".mixWithOthers" keeps the player's own Spotify/Music
    // running under the synth SFX — note WebKit takes a non-mixable session if the
    // in-game RADIO (real <audio> media) is played, which pauses their music; the
    // web keep-alive hack is disabled in the native app for exactly that reason.
    private func pinAudioSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        pinAudioSession()
        // Feed the device thermal state to the web layer's adaptive quality governor
        // (main.js reads window.__thermalState: 0 nominal .. 3 critical) so it can step
        // render load down before the phone gets hot and recover when it cools.
        NotificationCenter.default.addObserver(self, selector: #selector(thermalStateChanged),
            name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.pushThermalState() } // after the webview loads
        return true
    }

    @objc private func thermalStateChanged() { pushThermalState() }

    // Map ProcessInfo.thermalState → 0..3 and set it on window.__thermalState in the WKWebView.
    private func pushThermalState() {
        let level: Int
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: level = 0
        case .fair: level = 1
        case .serious: level = 2
        case .critical: level = 3
        @unknown default: level = 0
        }
        DispatchQueue.main.async {
            let vc = self.window?.rootViewController as? CAPBridgeViewController
            vc?.webView?.evaluateJavaScript("window.__thermalState = \(level);", completionHandler: nil)
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Re-assert the audio session — an interruption (call/Siri) or another app
        // taking the session can deactivate ours; without this the ring switch
        // would mute the game again after every interruption.
        pinAudioSession()
        pushThermalState() // refresh the governor's heat signal on resume
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
