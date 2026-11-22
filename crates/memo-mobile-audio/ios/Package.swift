// swift-tools-version:5.5

import PackageDescription

let package = Package(
    name: "memo-mobile-audio",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v15),
    ],
    products: [
        .library(
            name: "memo-mobile-audio",
            type: .static,
            targets: ["memo-mobile-audio"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "memo-mobile-audio",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources"
        )
    ]
)
