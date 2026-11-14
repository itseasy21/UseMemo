import AVFAudio
import AVFoundation
import SwiftRs
import Tauri
import UIKit
import WebKit

class MobileAudioPlugin: Plugin {
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

    /// `.playAndRecord` keeps alerts and other app audio audible while the
    /// meeting is captured; Bluetooth and the speaker are allowed so a headset
    /// or speakerphone is usable. The background mode lives in Info.ios.plist.
    @objc public func configureAudioSession(_ invoke: Invoke) {
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(
                    .playAndRecord,
                    mode: .default,
                    options: [.allowBluetooth, .defaultToSpeaker]
                )
                try session.setActive(true)
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
