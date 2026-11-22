use std::path::PathBuf;
use std::process::Command;

fn compile_apple_vision_ocr(target_os: &str) {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let src = manifest_dir.join("native/apple_vision_ocr.m");
    println!("cargo:rerun-if-changed={}", src.display());

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap_or_default());
    let obj = out_dir.join("apple_vision_ocr.o");
    let lib = out_dir.join("libmemo_vision_ocr.a");

    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "aarch64".into());
    let clang_arch = match target_arch.as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => other,
    };

    let mut clang = Command::new("xcrun");
    if target_os == "ios" {
        let target_triple = std::env::var("TARGET").unwrap_or_default();
        let sdk = if target_triple.contains("sim") {
            "iphonesimulator"
        } else {
            "iphoneos"
        };
        clang.args(["--sdk", sdk, "clang", "-miphoneos-version-min=15.0"]);
    } else {
        clang.args(["--sdk", "macosx", "clang", "-mmacosx-version-min=12.0"]);
    }

    let status = clang
        .args([
            "-fobjc-arc",
            "-O2",
            "-arch",
            clang_arch,
            "-c",
            &src.to_string_lossy(),
            "-o",
            &obj.to_string_lossy(),
        ])
        .status()
        .expect("failed to invoke xcrun clang for apple_vision_ocr.m");
    assert!(status.success(), "compiling apple_vision_ocr.m failed");

    let mut objects = vec![obj];
    if target_os == "macos" {
        let cap_src = manifest_dir.join("native/macos_capture.m");
        println!("cargo:rerun-if-changed={}", cap_src.display());
        let cap_obj = out_dir.join("macos_capture.o");
        let cap_status = Command::new("xcrun")
            .args([
                "--sdk",
                "macosx",
                "clang",
                "-mmacosx-version-min=12.0",
                "-fobjc-arc",
                "-O2",
                "-arch",
                clang_arch,
                "-c",
                &cap_src.to_string_lossy(),
                "-o",
                &cap_obj.to_string_lossy(),
            ])
            .status()
            .expect("failed to invoke xcrun clang for macos_capture.m");
        assert!(cap_status.success(), "compiling macos_capture.m failed");
        objects.push(cap_obj);

        let signal_src = manifest_dir.join("native/macos_call_signal.m");
        println!("cargo:rerun-if-changed={}", signal_src.display());
        let signal_obj = out_dir.join("macos_call_signal.o");
        let signal_status = Command::new("xcrun")
            .args([
                "--sdk",
                "macosx",
                "clang",
                "-mmacosx-version-min=12.0",
                "-fobjc-arc",
                "-O2",
                "-arch",
                clang_arch,
                "-c",
                &signal_src.to_string_lossy(),
                "-o",
                &signal_obj.to_string_lossy(),
            ])
            .status()
            .expect("failed to invoke xcrun clang for macos_call_signal.m");
        assert!(
            signal_status.success(),
            "compiling macos_call_signal.m failed"
        );
        objects.push(signal_obj);
    }

    let mut ar_cmd = Command::new("ar");
    ar_cmd.arg("crus").arg(&lib);
    for o in &objects {
        ar_cmd.arg(o);
    }
    let ar_status = ar_cmd
        .status()
        .expect("failed to invoke ar for libmemo_vision_ocr.a");
    assert!(ar_status.success(), "archiving libmemo_vision_ocr.a failed");

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=memo_vision_ocr");
    println!("cargo:rustc-link-lib=framework=Vision");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");
    println!("cargo:rustc-link-lib=framework=Foundation");
    if target_os == "macos" {
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
    }
}

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // ScreenCaptureKit's Swift bridge (`screencapturekit` -> `apple-metal`)
    // links `@rpath/libswift_Concurrency.dylib` and `libswiftCompatibility56.a`.
    // Emit both the dyld rpath and the active Xcode / CommandLineTools Swift
    // static library search directory so `cargo test`, `tauri build`, and CI
    // never need manual `RUSTFLAGS` workarounds.
    if target_os == "macos" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(output) = Command::new("xcrun").args(["--find", "swiftc"]).output() {
            if output.status.success() {
                let swiftc = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
                if let Some(usr_dir) = swiftc.parent().and_then(|bin| bin.parent()) {
                    candidates.push(usr_dir.join("lib/swift/macosx"));
                }
            }
        }
        candidates.push(PathBuf::from(
            "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx",
        ));
        candidates.push(PathBuf::from(
            "/Library/Developer/CommandLineTools/usr/lib/swift/macosx",
        ));

        for dir in candidates {
            if dir.is_dir() {
                println!("cargo:rustc-link-search=native={}", dir.display());
            }
        }
    }

    if target_os == "macos" || target_os == "ios" {
        compile_apple_vision_ocr(&target_os);

        // `whisper-rs-sys` (`ggml-metal-device.m`) uses `@available(...)`, which
        // emits `___isPlatformVersionAtLeast` from Apple Clang's compiler-rt
        // archive (`libclang_rt.osx.a` / `libclang_rt.ios.a`). `rustc` invokes
        // the linker with `-nodefaultlibs`, so link the active runtime explicitly.
        if let Ok(output) = Command::new("xcrun")
            .args(["clang", "--print-runtime-dir"])
            .output()
        {
            if output.status.success() {
                let runtime_dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
                if runtime_dir.is_dir() {
                    let rt_lib = if target_os == "ios" {
                        let triple = std::env::var("TARGET").unwrap_or_default();
                        if triple.contains("sim") {
                            "clang_rt.iossim"
                        } else {
                            "clang_rt.ios"
                        }
                    } else {
                        "clang_rt.osx"
                    };
                    if runtime_dir.join(format!("lib{rt_lib}.a")).is_file() {
                        println!("cargo:rustc-link-search=native={}", runtime_dir.display());
                        println!("cargo:rustc-link-lib=static={rt_lib}");
                    }
                }
            }
        }
    }

    tauri_build::build()
}
