fn main() {
    // ScreenCaptureKit's Swift bridge links `@rpath/libswift_Concurrency.dylib`.
    // On macOS 26+ that library only lives in the dyld shared cache under
    // /usr/lib/swift, and the Rust linker does not add that rpath itself, so
    // both the app and its test binaries would abort at launch without this.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_build::build()
}
