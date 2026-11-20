import AVFAudio
import AVFoundation
import SwiftRs
import Tauri
import UIKit
import WebKit

class MobileAudioPlugin: Plugin {
    private var observersInstalled = false

    @objc public func microphonePermission(_ invoke: Invoke) {
        invoke.resolve(["status": microphoneStatus()])
    }

    @objc public func requestMicrophonePermission(_ invoke: Invoke) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async {
                    invoke.resolve(["status": granted ? "granted" : "denied"])
                }
            }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    invoke.resolve(["status": granted ? "granted" : "denied"])
                }
            }
        }
    }

    /// `.playAndRecord` with `.mixWithOthers`, `.allowBluetooth`, `.allowBluetoothA2DP`,
    /// and `.defaultToSpeaker` keeps calls/alerts audible, supports HFP + A2DP AirPods,
    /// and recovers cleanly across phone-call / Siri interruptions.
    @objc public func configureAudioSession(_ invoke: Invoke) {
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(
                    .playAndRecord,
                    mode: .default,
                    options: [
                        .mixWithOthers,
                        .allowBluetooth,
                        .allowBluetoothA2DP,
                        .defaultToSpeaker,
                    ]
                )
                try session.setActive(true)
                self.installSessionObserversIfNeeded()
                invoke.resolve(["configured": true, "backend": "ios"])
            } catch {
                invoke.reject(
                    "cannot configure the iOS audio session: \(error.localizedDescription)"
                )
            }
        }
    }

    @objc public func deactivateAudioSession(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.removeSessionObservers()
            do {
                try AVAudioSession.sharedInstance().setActive(
                    false,
                    options: .notifyOthersOnDeactivation
                )
            } catch {
                // An inactive session is already the desired state.
            }
            invoke.resolve(["deactivated": true])
        }
    }

    private func installSessionObserversIfNeeded() {
        guard !observersInstalled else { return }
        observersInstalled = true
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        center.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    private func removeSessionObservers() {
        guard observersInstalled else { return }
        observersInstalled = false
        NotificationCenter.default.removeObserver(
            self,
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        NotificationCenter.default.removeObserver(
            self,
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let rawType = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType)
        else {
            return
        }

        switch type {
        case .began:
            trigger("audioSessionInterrupted", data: ["phase": "began"])
        case .ended:
            let rawOpts = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let opts = AVAudioSession.InterruptionOptions(rawValue: rawOpts)
            if opts.contains(.shouldResume) {
                try? AVAudioSession.sharedInstance().setActive(true)
            }
            trigger(
                "audioSessionInterrupted",
                data: ["phase": "ended", "resumed": opts.contains(.shouldResume)]
            )
        @unknown default:
            break
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        guard let info = notification.userInfo,
              let rawReason = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason)
        else {
            return
        }
        trigger("audioRouteChanged", data: ["reason": reason.rawValue])
    }

    private func microphoneStatus() -> String {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted:
                return "granted"
            case .denied:
                return "denied"
            case .undetermined:
                return "prompt"
            @unknown default:
                return "prompt"
            }
        }

        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted:
            return "granted"
        case .denied:
            return "denied"
        case .undetermined:
            return "prompt"
        @unknown default:
            return "prompt"
        }
    }
}

@_cdecl("init_plugin_mobile_audio")
public func initPlugin() -> Plugin {
    return MobileAudioPlugin()
}
